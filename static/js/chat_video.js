// WebRTC video chat handling
document.addEventListener('DOMContentLoaded', () => {
    // Global variables
    const socket = io();
    const localVideo = document.getElementById('local-video');
    const remoteVideo = document.getElementById('remote-video');
    const toggleVideoBtn = document.getElementById('toggle-video');
    const toggleAudioBtn = document.getElementById('toggle-audio');
    const shareScreenBtn = document.getElementById('share-screen');
    const partnerUsernameLabel = document.getElementById('partner-username');
    
    let localStream = null;
    let screenStream = null;
    let isScreenSharing = false;
    let localVideoEnabled = true;
    let localAudioEnabled = true;
    let peerConnection = null;
    
    // ICE server configuration (STUN servers)
    const iceServers = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    };

    // Initialize media devices
    async function initDevices() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            
            // Display local video
            localVideo.srcObject = localStream;
            
            // Join chat after getting media
            joinChat();
            
        } catch (error) {
            console.error('Error accessing media devices:', error);
            alert('Could not access camera or microphone. Please check your device settings and permissions.');
        }
    }

    // Join the chat
    function joinChat() {
        socket.emit('join_chat', { chat_id: CHAT_ID });
    }

    // Handle chat joined event
    socket.on('chat_joined', (data) => {
        console.log('Chat joined:', data);
        
        // Update partner username
        if (data.username !== USERNAME) {
            partnerUsernameLabel.textContent = data.partner;
        }
        
        // Create peer connection if it doesn't exist
        if (!peerConnection) {
            createPeerConnection();
            
            // Create and send offer
            createOffer();
        }
    });

    // Create peer connection
    function createPeerConnection() {
        peerConnection = new RTCPeerConnection(iceServers);
        
        // Add local tracks to the peer connection
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        
        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                socket.emit('ice_candidate', {
                    chat_id: CHAT_ID,
                    candidate: event.candidate
                });
            }
        };
        
        // Handle remote track
        peerConnection.ontrack = (event) => {
            remoteVideo.srcObject = event.streams[0];
        };
    }

    // Create and send offer
    async function createOffer() {
        try {
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            
            socket.emit('offer', {
                chat_id: CHAT_ID,
                offer: peerConnection.localDescription
            });
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }

    // Handle incoming offer
    socket.on('offer', async (data) => {
        if (!peerConnection) {
            createPeerConnection();
        }
        
        try {
            // Set remote description (the offer)
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            
            // Create and send answer
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            socket.emit('answer', {
                chat_id: CHAT_ID,
                answer: peerConnection.localDescription
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    });

    // Handle incoming answer
    socket.on('answer', async (data) => {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    });

    // Handle ICE candidate
    socket.on('ice_candidate', (data) => {
        if (peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
                .catch(error => console.error('Error adding ICE candidate:', error));
        }
    });

    // Handle user leaving
    socket.on('user_left', (data) => {
        console.log('User left:', data);
        
        // Clear remote video
        remoteVideo.srcObject = null;
        
        // Close peer connection
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        
        // Show message
        alert(`${data.username} has left the chat. You can find a new partner or return to the home page.`);
    });

    // Toggle video
    toggleVideoBtn.addEventListener('click', () => {
        localVideoEnabled = !localVideoEnabled;
        
        localStream.getVideoTracks().forEach(track => {
            track.enabled = localVideoEnabled;
        });
        
        // Update button state
        toggleVideoBtn.classList.toggle('muted', !localVideoEnabled);
        toggleVideoBtn.innerHTML = localVideoEnabled ? 
            '<i class="fas fa-video"></i>' : 
            '<i class="fas fa-video-slash"></i>';
    });

    // Toggle audio
    toggleAudioBtn.addEventListener('click', () => {
        localAudioEnabled = !localAudioEnabled;
        
        localStream.getAudioTracks().forEach(track => {
            track.enabled = localAudioEnabled;
        });
        
        // Update button state
        toggleAudioBtn.classList.toggle('muted', !localAudioEnabled);
        toggleAudioBtn.innerHTML = localAudioEnabled ? 
            '<i class="fas fa-microphone"></i>' : 
            '<i class="fas fa-microphone-slash"></i>';
    });

    // Screen sharing
    shareScreenBtn.addEventListener('click', async () => {
        try {
            if (!isScreenSharing) {
                // Start screen sharing
                screenStream = await navigator.mediaDevices.getDisplayMedia({
                    video: true
                });
                
                // Replace video track with screen track
                const videoTrack = screenStream.getVideoTracks()[0];
                
                // Replace track in peer connection
                const sender = peerConnection.getSenders().find(s => 
                    s.track && s.track.kind === 'video'
                );
                
                if (sender) {
                    sender.replaceTrack(videoTrack);
                }
                
                // Update local video display
                localVideo.srcObject = screenStream;
                
                // Listen for screen sharing end
                videoTrack.onended = () => {
                    stopScreenSharing();
                };
                
                isScreenSharing = true;
                shareScreenBtn.innerHTML = '<i class="fas fa-desktop"></i>';
                shareScreenBtn.classList.add('muted');
                
            } else {
                // Stop screen sharing
                stopScreenSharing();
            }
        } catch (error) {
            console.error('Error sharing screen:', error);
        }
    });

    // Stop screen sharing
    function stopScreenSharing() {
        if (screenStream) {
            screenStream.getTracks().forEach(track => track.stop());
            
            // Replace screen track with camera track
            const videoTrack = localStream.getVideoTracks()[0];
            
            const sender = peerConnection.getSenders().find(s => 
                s.track && s.track.kind === 'video'
            );
            
            if (sender) {
                sender.replaceTrack(videoTrack);
            }
            
            // Update local video display
            localVideo.srcObject = localStream;
            
            isScreenSharing = false;
            shareScreenBtn.innerHTML = '<i class="fas fa-desktop"></i>';
            shareScreenBtn.classList.remove('muted');
        }
    }

    // Handle beforeunload event
    window.addEventListener('beforeunload', () => {
        // Leave chat room
        socket.emit('leave_chat', { chat_id: CHAT_ID });
        
        // Close peer connection
        if (peerConnection) {
            peerConnection.close();
        }
        
        // Stop all tracks
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        
        if (screenStream) {
            screenStream.getTracks().forEach(track => track.stop());
        }
    });

    // Initialize
    initDevices();
});