import Express from 'express'
import cors from 'cors';
import Https from 'httpolyglot'
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process';
import { Server } from 'socket.io'
import MediaSoup from 'mediasoup'
import * as process from 'process'
import dotenv from 'dotenv'

dotenv.config()
const app = Express()
const __dirname = path.resolve()
const PORT = process.env.PORT


app.use(cors({
    origin: '*',
    methods: ["GET", "POST"],
    optionsSuccessStatus: 200 // some legacy browsers (IE11, various SmartTVs) choke on 204
}));

app.use('/broadcast/:room', Express.static(path.join(__dirname, 'public')))
app.use('/broadcast/:room/files', Express.static(path.join(__dirname, 'files')));

app.get('*', (req, res, next) => {
    const path = '/broadcast/'
    if (req.path.indexOf(path) === 0 && req.path.length > path.length) return next()

    res.send(`You need to specify a room name in the path e.g. 'https://127.0.0.1/broadcast/room'`)
})

// SSL Options
const options = {
    key: fs.readFileSync('./server/ssl/key.pem', 'utf-8'),
    cert: fs.readFileSync('./server/ssl/cert.pem', 'utf-8')
}

// HTTP Server
const httpsServer = Https.createServer(options, app)
httpsServer.listen(PORT, () => {
    console.log('listening on port: ' + PORT)
})

const io = new Server(httpsServer)
const connections = io.of('/mediasoup');

let worker;
let rooms = {};
let peers = {};
let transports = [];
let producers = [];
let consumers = [];
let gstProcess = null;


const createWorker = async () => {
    worker = await MediaSoup.createWorker({
        rtcMinPort: 30000,
        rtcMaxPort: 31000,
    })
    console.log(`worker pid ${worker.pid}`)
    worker.on('died', error => {
        console.error('MediaSoup worker died!')
        setTimeout(() => process.exit(1), 2000) // exit in 2 seconds
    })
    return worker
}

worker = createWorker()

const mediaCodecs = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000, // 오디오 샘플랭 속도
        channels: 2,
    },
    {
        kind: 'video',
        mimeType: 'video/h264', //video/VP8
        clockRate: 90000, // 비디오 클럭 틱 속도
        parameters: {
            'x-google-start-bitrate': 1000,
        },
    },
]


connections.on('connection', async socket => {
    console.log(`SocketId: ${socket.id}`);
    socket.emit('connection-success', {socketId: socket.id});

    socket.on('disconnect', () => disconnect(socket));
    socket.on('joinRoom', async ({roomName}, callback) => joinRoom(socket, roomName, callback));
    socket.on('loadRTSP', ({rtspUrl, streamName}, callback) => getRTSP(rtspUrl, streamName, callback));
    socket.on('createWebRtcTransport', async ({consumer}, callback) => handleCreateWebRtcTransport(socket, consumer, callback));
    socket.on('getProducers', callback => getProducers(socket, callback));
    socket.on('transport-connect', ({ dtlsParameters }) => transportConnect(socket, dtlsParameters));
    socket.on('transport-produce', async ({ kind, rtpParameters, appData }, callback) => handleTransportProduce(socket, kind, rtpParameters, callback));
    socket.on('transport-recv-connect', async ({ dtlsParameters, serverConsumerTransportId }) => handleTransportRecvConnect(socket, dtlsParameters, serverConsumerTransportId));
    socket.on('consume', async ({ rtpCapabilities, remoteProducerId, serverConsumerTransportId }, callback) => handleConsume(socket, rtpCapabilities, remoteProducerId, serverConsumerTransportId, callback));
    socket.on('consumer-resume', async ({ serverConsumerId }) => handleConsumerResume(serverConsumerId));
});

const disconnect = socket => {
    if (gstProcess) {
        console.log('Terminating GStreamer process...');
        gstProcess.kill('SIGINT'); // 또는 'SIGTERM'을 시도해 봅니다.
        gstProcess = null; // 프로세스 변수 초기화
    } else {
        console.warn('No GStreamer process to terminate.');
    }

    if (peers[socket.id]) {
       console.log('Peer disconnectd');
       consumers = removeItems(consumers, socket.id, 'consumer');
       producers = removeItems(producers, socket.id, 'producer');
       transports = removeItems(transports, socket.id, 'transport');

       const {roomName} = peers[socket.id];
       console.log(roomName);

       rooms[roomName] = {
           router: rooms[roomName].router,
           peers: rooms[roomName].peers.filter(socketId => socketId !== socket.id)
       };

       delete peers[socket.id];
    } else {
        console.warn(`No peer found for socketId: ${socket.id}`)
    }
};

const joinRoom = async (socket, roomName, callback) => {
    const router = await createRoom(roomName, socket.id);
    peers[socket.id] = {
        socket,
        roomName,
        transports: [],
        producers: [],
        consumers: [],
        peerDetails: { name: '', isAdmin: false }
    };

    const rtpCapabilities = router.rtpCapabilities;
    console.log('RTP Capabilities: ', rtpCapabilities);
    callback({ rtpCapabilities });
};


const createRoom=  async (roomName, socketId) => {
    let router;
    let peers = [];

    if (rooms[roomName]) {
        router = rooms[roomName].router;
        peers = rooms[roomName].peers || [];
    } else {
        router = await worker.createRouter({mediaCodecs})
    }

    console.log(`Router ID: ${router.id}`, peers.length);

    rooms[roomName] = {
        router: router,
        peers: [...peers, socketId],
    };
    console.log('Room created: ', router);
    return router;
};

const getRTSP = async (rtspUrl, streamName, callback) => {
    console.log('RTSP URL: ', rtspUrl);
    console.log('Stream Name: ', streamName);

    const directoryPath = path.join(__dirname, 'files', streamName);

    //Check if directory exists, if not create it
    if (!fs.existsSync(directoryPath)) {
        fs.mkdirSync(directoryPath, {recursive: true});
        console.log(`Directory created: ${directoryPath}`);
    } else {
        console.log(`Directory already exist: ${directoryPath}`)
    }

    const gstCommand = `gst-launch-1.0 rtspsrc location=${rtspUrl} protocols=tcp is-live=true ! rtph264depay ! avdec_h264 ! x264enc speed-preset=ultrafast tune=zerolatency byte-stream=true bitrate=3000 threads=1 ! mpegtsmux ! hlssink max-files=10 playlist-location=${directoryPath}/playlist.m3u8 location=${directoryPath}/segment%05d.ts target-duration=10`

    gstProcess = spawn(gstCommand, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe']
    })
    console.log('GStreamer pipeline started');

    gstProcess.stdout.on('data', data => {
        console.log(`GStreamer stdout: ${data}`)
    })
    gstProcess.stderr.on('data', data => {
        console.error(`GStreamer stderr: ${data}`)
    })
    gstProcess.on('error', error => {
        console.error(`GStreamer error: ${error}`)
    })
    gstProcess.on('close', code => {
        console.log(`GStreamer process closed with code: ${code}`)
    })

    callback({ status: 'started'})
}

const handleCreateWebRtcTransport = async (socket, consumer, callback) => {
    console.log(`Is this a sender request> ${consumer}`)

    const roomName = peers[socket.id].roomName;
    const router = rooms[roomName].router;

    try {
        const transport = await createWebRtcTransport(router);
        callback({
            params: {
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            }
        });
        addTransport(socket, transport, roomName, consumer);
    } catch (error) {
        console.error('Failed to create WebRTC transport:', error)
        callback({ error: 'Failed to create WebRTC transport' })
    }
};

const getProducers = (socket, callback) => {
    const { roomName } = peers[socket.id];
    let producerList = producers.filter(producerData => producerData.socketId !== socket.id && producerData.roomName === roomName)
        .map(producerData => producerData.producer.id);

    callback(producerList);
}

const transportConnect = (socket, dtlsParameters) => {
    console.log('DTLS PARAMS...', dtlsParameters);
    getTransport(socket.id).connect({dtlsParameters})
};

const handleTransportProduce = async (socket, kind, rtpParameters, callback) => {
    try {
        const producer = await getTransport(socket.id).produce({kind, rtpParameters});
        const {roomName} = peers[socket.id];
        addProducer(socket, producer, roomName);
        informConsumers(roomName, socket.id, producer.id);

        console.log('Producer ID: ', producer.id, producer.kind);

        producer.on('transportclose', () => {
            console.log('Transport close from producer');
            producer.close();
        })

        callback({ id: producer.id, producersExist: producers.length > 1 });
    } catch (error) {
        console.error('Failed to produce:', error)
        callback({ error: 'Failed to produce' })
    }
};

const handleTransportRecvConnect = async (socket, dtlsParameters, serverConsumerTransportId) => {
    console.log(`DTLS PARAMS: ${dtlsParameters}`);
    const consumerTransport = transports.find(transportData => transportData.consumer && transportData.transport.id == serverConsumerTransportId).transport;
    await consumerTransport.connect({ dtlsParameters });
};

const handleConsume = async (socket, rtpCapabilities, remoteProducerId, serverConsumerTransportId, callback) => {
    try {
        console.log(`Server Consumer Transport Id: ${serverConsumerTransportId}`)

        const { roomName } = peers[socket.id];
        const router = rooms[roomName].router;
        const consumerTransport = transports.find(transportData => transportData.consumer && transportData.transport.id == serverConsumerTransportId).transport;

        if (router.canConsume({ producerId: remoteProducerId, rtpCapabilities })) {
            const consumer = await consumerTransport.consume({ producerId: remoteProducerId, rtpCapabilities, paused: true });

            consumer.on('transportclose', () => console.log('Transport close from consumer'));
            consumer.on('producerclose', () => handleProducerClose(socket, consumer, remoteProducerId, consumerTransport));

            addConsumer(socket, consumer, roomName);

            const params = {
                id: consumer.id,
                producerId: remoteProducerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                serverConsumerId: consumer.id,
            };
            callback({ params });
        }
    } catch (error) {
        console.error('Failed to consume:', error)
        callback({ params: 'Failed to consume' })
    }
};

const handleConsumerResume = async serverConsumerId => {
    console.log('Consumer resume', serverConsumerId);
    const { consumer } = consumers.find(consumerData => consumerData.consumer.id === serverConsumerId);
    await consumer.resume();
};

const handleProducerClose = (socket, consumer, remoteProducerId, consumerTransport) => {
    console.log('Producer of consumer closed');
    socket.emit('producer-closed', { remoteProducerId })

    consumerTransport.close([]);
    transports = transports.filter(transportData => transportData.transport.id !== consumerTransport.id);
    consumer.close();
    consumers = consumers.filter(consumerData => consumerData.consumer.id !== consumer.id);
};

const addTransport = (socket, transport, roomName, consumer) => {
    transports.push({ socketId: socket.id, transport, roomName, consumer });
    peers[socket.id].transports.push(transport.id);
};

const addProducer = (socket, producer, roomName) => {
    producers.push({ socketId: socket.id, producer, roomName });
    peers[socket.id].producers.push(producer.id);
};

const addConsumer = (socket, consumer, roomName) => {
    consumers.push({ socketId: socket.id, consumer, roomName });
    peers[socket.id].consumers.push(consumer.id);
};

const informConsumers = (roomName, socketId, id) => {
    console.log(`New Producer joined, ID ${id} in room ${roomName}`);
    producers.forEach(producerData => {
        if (producerData.socketId !== socketId && producerData.roomName === roomName) {
            const producerSocket = peers[producerData.socketId].socket;
            producerSocket.emit('new-producer', { producerId: id })
        }
    });
};

const getTransport = socketId => {
    const [producerTransport] = transports.filter(transport => transport.socketId === socketId && !transport.consumer);
    return producerTransport.transport;
}

const removeItems = (items, socketId, type) => {
    items.forEach(item => {
        if (item.socketId === socketId) {
            item[type].close();
        }
    });
    return items.filter(item => item.socketId !== socketId);
}

const createWebRtcTransport = async router => {
    try {
        const webRtcTransport_options = {
            listenIps: [
                {
                    ip: '127.0.0.1',
                    // announcedIp: '192.168.0.9',
                },
            ],
            enableUdp: true,
            enableTcp: true,
            preferUdp: true,
            initialAvailableOutgoingBitrate: 1000000,
            maxIncomingBitrate: 1000000,
            minimumAvailableOutgoingBitrate: 300000,
            numSctpStreams: { OS: 1024, MIS: 1024 },
            enableDtls: true,
            preferIPv6: false,
            preferIPv4: true,
            rtcpMux: true,
            enableBwe: true,
            maxSctpMessageSize: 262144,
        };

        const transport = await router.createWebRtcTransport(webRtcTransport_options);
        console.log(`Created WebRTC transport with ID: ${transport.id}`);

        transport.on('dtlsstatechange', dtlsState => {
            console.log(`WebRTC transport DTLS state changed to ${dtlsState}`);
            if (dtlsState === 'closed') transport.close();
        });

        transport.on('close', () => console.log('WebRTC transport closed'));

        return transport;
    } catch (error) {
        console.error('Failed to create WebRtc Transport: ', error);
        throw error;
    }
}