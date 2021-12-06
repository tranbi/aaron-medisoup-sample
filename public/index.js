const io = require('socket.io-client')
const mediasoupClient = require('mediasoup-client')
const socket = io('/mediasoup')

const roomName = window.location.pathname.split('/')[2]


socket.on('connection-success', ({socketId} ) => {
	console.log(socketId)
	getLocalStream()
})

let device
let rtpCapabilities
let producerTransport
let consumerTransports = []
let producer

let params = {
	// mediasoup params
	encodings: [
	  {
		rid: 'r0',
		maxBitrate: 100000,
		scalabilityMode: 'S1T3',
	  },
	  {
		rid: 'r1',
		maxBitrate: 300000,
		scalabilityMode: 'S1T3',
	  },
	  {
		rid: 'r2',
		maxBitrate: 900000,
		scalabilityMode: 'S1T3',
	  },
	],
	// https://mediasoup.org/documentation/v3/mediasoup-client/api/#ProducerCodecOptions
	codecOptions: {
	  videoGoogleStartBitrate: 1000
	}
}

const streamSuccess = (stream) => {
	localVideo.srcObject = stream
	const track = stream.getVideoTracks()[0]
	params = {
		track,
		...params
	}

	joinRoom()
}

const joinRoom = () => {
	socket.emit('joinRoom', { roomName }, (data) => {
		console.log(`Router RTP Capabilities... ${data.rtpCapabilities}`)
		// we assign to local variable and will be used when
		// loading the client Device (see createDevice above)
		rtpCapabilities = data.rtpCapabilities
	
		// once we have rtpCapabilities from the Router, create Device
		createDevice()
	})
}

const getLocalStream = () => {
	navigator.mediaDevices.getUserMedia({
		audio: false,
		video: {
			width: {
				min: 640,
				max: 1920,
			},
			height: {
				min: 400,
				max: 1080,
			}
		}
	})
	.then(streamSuccess)
	.catch(error => {
		console.log(error.message)
	})
}

// server informs the client of a new producer just joined
socket.on('new-producer', ({ producerId }) => signalNewConsumerTransport(producerId))

const getProducers = () => {
	// chúng ta cần nhận list producers từ server (producerIds)
	// mỗi 1 producer đang tồn tại trên server sẽ tương ứng với 1 consumer cần được tạo
	socket.emit('getProducers', producerIds => {
		console.log(producerIds)
		// for each of the producer create a consumer
		// producerIds.forEach(id => signalNewConsumerTransport(id))
		producerIds.forEach(signalNewConsumerTransport)
	})
}

const createDevice = async () => {
	try {
		device = new mediasoupClient.Device()
	
		// https://mediasoup.org/documentation/v3/mediasoup-client/api/#device-load
		// Loads the device with RTP capabilities of the Router (server side)
		await device.load({
			// see getRtpCapabilities() below
			routerRtpCapabilities: rtpCapabilities
		})
	
		console.log('Device RTP Capabilities', device.rtpCapabilities)
	
		// once the device loads, create transport
		createSendTransport()
	
	} catch (error) {
		console.log(error)
		if (error.name === 'UnsupportedError') {
			console.warn('browser not supported')
		}
	}
}

const createSendTransport = () => {
	socket.emit('createWebRtcTransport', { consumer: false }, ({ params }) => {
		if (params.error) {
			console.log(params.error)
			return
		}

		producerTransport = device.createSendTransport(params);
		
		producerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
			try {
				// Signal local DTLS parameters to the server side transport
				// see server's socket.on('transport-connect', ...)
				await socket.emit('transport-connect', {
					dtlsParameters,
				})
		
				// Tell the transport that parameters were transmitted.
				callback()
		
			} catch (error) {
				errback(error)
			}
		})
	  
		producerTransport.on('produce', async (parameters, callback, errback) => {
			try {
				// tell the server to create a Producer
				// with the following parameters and produce
				// and expect back a server side producer id
				// see server's socket.on('transport-produce', ...)
				await socket.emit('transport-produce', {
					kind: parameters.kind,
					rtpParameters: parameters.rtpParameters,
					appData: parameters.appData,
				}, ({ id, producersExist }) => {
					// Tell the transport that parameters were transmitted and provide it with the
					// server side producer's id.
					callback({ id })
					if (producersExist) {
						getProducers()
					}
				})
			} catch (error) {
				errback(error)
			}
		})

		connectSendTransport()
	})
}

const connectSendTransport = async () => {
	producer = await producerTransport.produce(params)

	producer.on('trackended', () => {
		console.log('track ended')
		// close video track
	})

	producer.on('transportclose', () => {
		console.log('transport ended')
		// close video track
	})
}

const signalNewConsumerTransport = async (remoteProducerId) => {
	socket.emit('createWebRtcTransport', { consumer: true }, ({ params }) => {
		if (params.error) {
			console.log(params.error)
			return
		}

		consumerTransport = device.createRecvTransport(params);
		  
		consumerTransport.on('connect', async ({ dtlsParameters }, callback, errback) => {
			try {
				// Signal local DTLS parameters to the server side transport
				// see server's socket.on('transport-connect', ...)
				await socket.emit('transport-recv-connect', {
					dtlsParameters,
					serverConsumerTransportId: params.id,
				})
		
				// Tell the transport that parameters were transmitted.
				callback()
		
			} catch (error) {
				errback(error)
			}
		})

		// connect tới recv transport mà chúng ta vừa tạo
		// params.id là server side params id mà chúng ta vừa nhận được vừa việc tạo createWebRtcTransport
		connectRecvTransport(consumerTransport, remoteProducerId, params.id)
	})
}

const connectRecvTransport = async (consumerTransport, remoteProducerId, serverConsumerTransportId) => {
	// for consumer, we need to tell the server first
	// to create a consumer based on the rtpCapabilities and consume
	// if the router can consume, it will send back a set of params as below
	await socket.emit('consume', {
		rtpCapabilities: device.rtpCapabilities,
		remoteProducerId,
		serverConsumerTransportId,
	}, async ({ params }) => {
		if (params.error) {
		console.log('Cannot Consume')
		return
		}

		console.log(`Consumer Params ${params}`)
		// then consume with the local consumer transport
		// which creates a consumer
		const consumer = await consumerTransport.consume({
		id: params.id,
		producerId: params.producerId,
		kind: params.kind,
		rtpParameters: params.rtpParameters
		})

		consumerTransports = [
		...consumerTransports,
		{
			consumerTransport,
			serverConsumerTransportId: params.id,
			producerId: remoteProducerId,
			consumer,
		},
		]

		// create a new div element for the new consumer media
		// and append to the video container
		const newElem = document.createElement('div')
		newElem.setAttribute('id', `td-${remoteProducerId}`)
		newElem.setAttribute('class', 'remoteVideo')
		newElem.innerHTML = '<video id="' + remoteProducerId + '" autoplay class="video" ></video>'
		videoContainer.appendChild(newElem)

		// destructure and retrieve the video track from the producer
		const { track } = consumer
		console.log(document.getElementById(remoteProducerId))


		document.getElementById(remoteProducerId).srcObject = new MediaStream([track])

		// the server consumer started with media paused
		// so we need to inform the server to resume
		socket.emit('consumer-resume', { serverConsumerId: params.serverConsumerId })
	})
  }

socket.on('producer-closed', ({ remoteProducerId }) => {
	// server notification is received when a producer is closed
	// we need to close the client-side consumer and associated transport
	const producerToClose = consumerTransports.find(transportData => transportData.producerId === remoteProducerId)
	producerToClose.consumerTransport.close()
	producerToClose.consumer.close()

	// remove the consumer transport from the list
	consumerTransports = consumerTransports.filter(transportData => transportData.producerId !== remoteProducerId)

	// remove the video div element
	videoContainer.removeChild(document.getElementById(`td-${remoteProducerId}`))
})