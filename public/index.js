
import io from 'socket.io-client';
import * as mediasoupClient from 'mediasoup-client';
import Hls from 'hls.js';

const roomName = window.location.pathname.split('/')[2];
const socket = io('/mediasoup');

let device;
let rtpCapabilities;
let producerTransport;
let consumerTransports = [];
let audioProducer;
let videoProducer;
let consumingTransports = [];
let hlsPlayer;

const isMobile = () => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
};

const params = {
    encodings: isMobile() ? [
        { rid: 'r0', maxBitrate: 50000, scalabilityMode: 'L1T1' },
        { rid: 'r1', maxBitrate: 150000, scalabilityMode: 'L1T1' },
    ] : [
        { rid: 'r0', maxBitrate: 100000, scalabilityMode: 'S1T3' },
        { rid: 'r1', maxBitrate: 300000, scalabilityMode: 'S1T3' },
        { rid: 'r2', maxBitrate: 900000, scalabilityMode: 'S1T3' },
    ],
    codecOptions: {
        videoGoogleStartBitrate: isMobile() ? 500 : 1000
    }
};

let videoParams = { params };
let audioParams;

socket.on('connections-success', ({ socketId }) => {
    console.log(`SocketId: ${socketId}`);
});


const streamSuccess = async (stream) => {
    localVideo.srcObject = stream;

    audioParams = { track: stream.getAudioTracks()[0], ...audioParams };
    videoParams = { track: stream.getVideoTracks()[0], ...videoParams };
    console.log(audioParams, videoParams);
    joinRoom();
};

const loadFile = async () => {
    const file = fileInput.files[0];
    if (!file) {
        console.error('No File selected');
        return;
    }
    const url = URL.createObjectURL(file);
    localVideo.src = url;
    await localVideo.play();

    const fileStream = localVideo.captureStream();
    console.log(fileStream);
    if (fileStream) {
        audioParams = { track: fileStream.getAudioTracks()[0], ...audioParams };
        videoParams = { track: fileStream.getVideoTracks()[0], ...videoParams };
        console.log(audioParams, videoParams);
        joinRoom();
    } else {
        console.error('No File selected');
    }
};

// RTSP URL 이름 추출
const extractStreamName = (rtspUrl) => {
    const match = rtspUrl.match(/\/(\w+)\.stream$/);
    if (match && match.length > 1) {
        return match[1];
    }

    return null;
}

const loadRTSP = async () => {
    const rtspUrl = document.getElementById('rtspUrlInput').value;
    if (!rtspUrl) {
        console.error('RTSP URL not found');
        return;
    }
    console.log(rtspUrl);
    const streamName = extractStreamName(rtspUrl);
    console.log(`Stream Name: ${streamName}`);
    if (!streamName) {
        console.error('Failed to extract stream name from RTSP URL');
        return;
    }


    socket.emit('loadRTSP', { rtspUrl, streamName }, (response) => {
        console.log('RTSP load callback received', response);
        setupHls(streamName);
    })
};

const setupHls = (streamName) => {
    const videoElement = document.getElementById('localVideo');
    if (Hls.isSupported()) {
        if (hlsPlayer) {
            hlsPlayer.destroy();
            hlsPlayer = null;
        }
        hlsPlayer = new Hls({
            liveSyncDuration: 10, // 라이브 싱크 지속시간
            maxBufferLength: 30, //최대 버퍼 길이
            maxMaxBufferLength: 60, // 최대 버퍼 같이 상한
            lowLatencyMode: true
        });

        // hlsPlayer.loadSource(`https://192.168.0.9:3100/broadcast/${roomName}/files/${streamName}/playlist.m3u8`);
        hlsPlayer.loadSource(`https://127.0.0.1:3000/broadcast/${roomName}/files/${streamName}/playlist.m3u8`);
        hlsPlayer.attachMedia(videoElement);
        hlsPlayer.on(Hls.Events.MANIFEST_PARSED, () => {
            videoElement.play().catch(error => console.log('Failed to play video: ', error));
        });

        hlsPlayer.on(Hls.Events.FRAG_LOADING, (event, data) => {
            const fileStream = videoElement.captureStream();
            console.log('HLS stream:', fileStream);
            const audioTrack = fileStream.getAudioTracks()[0];
            const videoTrack = fileStream.getVideoTracks()[0];
            audioParams = audioTrack ? { track: audioTrack, ...audioParams } : null;
            videoParams = videoTrack ? { track: videoTrack, ...videoParams } : null;
            console.log("HLS Video Params: ", videoParams);
            console.log("HLS Audio Params: ", audioParams);
        });
        hlsPlayer.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        console.error('Network error encountered:', data);
                        hlsPlayer.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        console.error('Media error encountered:', data);
                        hlsPlayer.recoverMediaError();
                        break;
                    default:
                        console.error('An unrecoverable error occurred:', data);
                        hlsPlayer.destroy();
                        break;
                }
            }
        });
    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        // videoElement.src =`https://192.168.0.9:3100/broadcast/${roomName}/files/${streamName}/playlist.m3u8`;
        videoElement.src =`https://127.0.0.1:3000/broadcast/${roomName}/files/${streamName}/playlist.m3u8`;
        videoElement.addEventListener('canplay', async function() {
            await videoElement.play().catch(error => console.error('Error attempting to play:', error));
        });
    }
};

const publishRTSP = () => {
    joinRoom();
}

const joinRoom = async () => {
    socket.emit('joinRoom', { roomName }, (data) => {
        console.log(`Router RTP Capabilities: ${data.rtpCapabilities}`);
        rtpCapabilities = data.rtpCapabilities;
        createDevice();
    });
};

const getLocalStream = () => {
    navigator.mediaDevices.getUserMedia(
        {
            audio: true,
            video:  {
                width: { min: 640, ideal: 1280, max: 1920 },
                height: { min: 400, ideal: 720, max: 1090 },
            }
        })
       .then(streamSuccess)
       .catch(error => console.error('Error getting user media:', error));
};


const createDevice = async () => {
    try {
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities: rtpCapabilities });
        console.log('Device RTP Capabilities', device.rtpCapabilities);
        createSendTransport();
    } catch (error) {
        console.log(error);
        if (error.name === 'UnsuppportedError') {
            console.warn('browser not supported');
        }
    }
};

const createSendTransport = () => {
    socket.emit('createWebRtcTransport', { consumer: false }, ({ params }) => {
        if (params.error) {
            console.log(params.error);
            return;
        }
        console.log('createWebRTCTransport:', params);

        producerTransport = device.createSendTransport({
            ...params,
            iceServers: isMobile() ? iceServers : [],
            enableUdp: true,
            enableTcp: true,
            preferUdp: isMobile(),
        });

        producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await socket.emit('transport-connect', { dtlsParameters });
                callback();
            } catch (error) {
                errback(error);
            }
        });

        producerTransport.on('icecandidate', event => {
            if (event.candidate) {
                console.log('New ICE candidate', event.candidate);
            } else {
                console.log('All ICE candidate have been gathered');
            }
        })

        producerTransport.on('produce', async (parameters, callback, errback) => {
            try {
                await socket.emit('transport-produce', {
                    kind: parameters.kind,
                    rtpParameters: parameters.rtpParameters,
                    appData: parameters.appData
                }, ({ id, producersExist }) => {
                    callback({ id });
                    if (producersExist) getProducers();
                });
            } catch (error) {
                errback(error);
            }
        });

        connectSendTransport();
    });
}

const connectSendTransport = async () => {
    audioProducer = audioParams ? await producerTransport.produce(audioParams) : null;
    videoProducer = await producerTransport.produce(videoParams);

    console.log('audioProducer', audioProducer)
    console.log('videoProducer', videoProducer)

    if (audioProducer) {
        audioProducer.on('trackended', () => console.log('audio track ended'));
        audioProducer.on('transportclose', () => console.log('audio producer closed'));
    }

    videoProducer.on('trackended', () =>  console.log('video track ended'));
    videoProducer.on('transportclose', () => console.log('video producer closed'));
};

const signalNewConsumerTransport = async (remoteProducerId) => {
    if (consumingTransports.includes(remoteProducerId)) return;

    consumingTransports.push(remoteProducerId);
    await socket.emit('createWebRtcTransport', { consumer: true }, ({ params }) => {
        if (params.error) {
            console.log(params.error);
            return;
        }
        console.log(`PARAMS: ${params}`);
        let consumerTransport;
        try {
            consumerTransport = device.createRecvTransport({
                ...params,
                iceServers: isMobile() ? iceServers : [],
                enableUdp: true,
                enableTcp: true,
                preferUdp: isMobile()
            });
        } catch (error) {
            console.log(error);
            return;
        }

        consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
            try {
                await socket.emit('transport-recv-connect', {
                    dtlsParameters,
                    serverConsumerTransportId: params.id,
                });
                callback();
            } catch (error) {
                errback(error);
            }
        });

        connectRecvTransport(consumerTransport, remoteProducerId, params.id);
    });
};

const connectRecvTransport = async (consumerTransport, remoteProducerId, serverConsumerTransportId) => {
    await socket.emit('consume', {
        rtpCapabilities: device.rtpCapabilities,
        remoteProducerId,
        serverConsumerTransportId,
    }, async ({ params }) => {
        if (params.error) {
            console.log(params.error);
            console.log('Cannot Consume');
            return;
        }
        console.log(`consumerParams: ${params}`);

        const consumer = await consumerTransport.consume({
            id: params.id,
            producerId: params.producerId,
            kind: params.kind,
            rtpParameters: params.rtpParameters,
        });

        consumerTransports.push({ consumerTransport, serverConsumerTransportId: params.id, producerId: remoteProducerId, consumer });const newElem = document.createElement('div');
        newElem.setAttribute('id', `td-${remoteProducerId}`);

        if (params.kind === 'audio') {
            newElem.innerHTML = `<audio id="${remoteProducerId}" autoplay></audio>`;
        } else {
            newElem.setAttribute('class', 'remoteVideo');
            newElem.innerHTML = `<video id="${remoteProducerId}" autoplay class="video"></video>`;
        }

        videoContainer.appendChild(newElem);
        document.getElementById(remoteProducerId).srcObject = new MediaStream([consumer.track]);
        socket.emit('consumer-resume', { serverConsumerId: params.serverConsumerId });
    })
};

const getProducers = () => {
    socket.emit('getProducers', (producerIds) => {
        producerIds.forEach(signalNewConsumerTransport);
    });
};

socket.on('new-producer', ({ producerId }) => signalNewConsumerTransport(producerId));

socket.on('producer-closed', ({ remoteProducerId }) => {
    const producerToClose = consumerTransports.find(transportData => transportData.producerId === remoteProducerId);
    producerToClose.consumerTransport.close();
    producerToClose.consumer.close();
    consumerTransports = consumerTransports.filter(transportData => transportData.producerId !== remoteProducerId);
    videoContainer.removeChild(document.getElementById(`td-${remoteProducerId}`));
});

const addEventListeners = () => {
    btnLocalVideo.addEventListener('click', getLocalStream);
    btnLoadFile.addEventListener('click', loadFile);
    btnPublishRTSP.addEventListener('click', publishRTSP);
    btnLoadRTSP.addEventListener('click', loadRTSP);
};

document.addEventListener('DOMContentLoaded', addEventListeners);
