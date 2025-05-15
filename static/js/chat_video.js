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
    const connectionStatus = document.getElementById('connection-status');
    const statusText = document.getElementById('status-text');
    
    // Check if required elements exist
    if (!localVideo) {
        console.error('Local video element not found');
    }
    if (!remoteVideo) {
        console.error('Remote video element not found');
    }
    if (!connectionStatus) {
        console.error('Connection status element not found');
    }

    // Make sure CHAT_ID is defined
    if (typeof CHAT_ID === 'undefined' || !CHAT_ID) {
        console.error('CHAT_ID is not defined!');
        if (connectionStatus) {
            updateConnectionStatus('disconnected', 'Error: Chat ID is not defined. Please refresh and try again.');
        }
        return;
    }
    
    let localStream = null;
    let screenStream = null;
    let isScreenSharing = false;
    let localVideoEnabled = true;
    let localAudioEnabled = true;
    let peerConnection = null;
    let isConnected = false;
    let connectionAttempts = 0;
    const MAX_CONNECTION_ATTEMPTS = 5;
    
    // ICE server configuration (STUN and TURN servers)
    const iceServers = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            // Free TURN servers (you should replace these with your own in production)
            {
                urls: 'turn:openrelay.metered.ca:80',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            },
            {
                urls: 'turn:openrelay.metered.ca:443',
                username: 'openrelayproject',
                credential: 'openrelayproject'
            }
        ],
        iceCandidatePoolSize: 10
    };

    // Update connection status UI
    function updateConnectionStatus(status, message) {
        if (!connectionStatus || !statusText) return;
        
        connectionStatus.className = status;
        statusText.textContent = message;
    }

    // Initialize media devices with improved error handling
    async function initDevices() {
        try {
            console.log('Requesting media permissions...');
            updateConnectionStatus('connecting', 'მედია წვდომის მოთხოვნა...');
            
            // Try with less restrictive constraints first
            localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 }
                },
                audio: true
            });
            
            console.log('Media permissions granted, displaying local video');
            updateConnectionStatus('connecting', 'ვუკავშირდებით პარტნიორს...');
            
            // Display local video
            if (localVideo) {
                localVideo.srcObject = localStream;
            }
            
            localVideoEnabled = true;
            localAudioEnabled = true;
            updateMediaButtons();
            
            // Join chat after getting media
            joinChat();
            
        } catch (error) {
            console.error('Error accessing media devices:', error);
            
            // Try with just audio if video fails
            try {
                console.log('Trying with just audio...');
                localStream = await navigator.mediaDevices.getUserMedia({
                    video: false,
                    audio: true
                });
                
                console.log('Access granted for audio only');
                if (localVideo) {
                    localVideo.srcObject = localStream;
                    // Add a "video disabled" overlay
                    const videoDisabledOverlay = document.createElement('div');
                    videoDisabledOverlay.style.position = 'absolute';
                    videoDisabledOverlay.style.top = '0';
                    videoDisabledOverlay.style.left = '0';
                    videoDisabledOverlay.style.width = '100%';
                    videoDisabledOverlay.style.height = '100%';
                    videoDisabledOverlay.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
                    videoDisabledOverlay.style.display = 'flex';
                    videoDisabledOverlay.style.justifyContent = 'center';
                    videoDisabledOverlay.style.alignItems = 'center';
                    videoDisabledOverlay.style.color = 'white';
                    videoDisabledOverlay.textContent = 'Camera disabled';
                    
                    const container = localVideo.parentElement;
                    if (container) {
                        container.appendChild(videoDisabledOverlay);
                    }
                }
                
                localVideoEnabled = false;
                localAudioEnabled = true;
                updateMediaButtons();
                
                updateConnectionStatus('connecting', 'ვიდეო გამორთულია, ვუკავშირდებით მხოლოდ აუდიოთი...');
                
                // Join chat with audio only
                joinChat();
                
            } catch (audioError) {
                console.error('Error accessing audio either:', audioError);
                
                // Try with minimal constraints as last resort
                try {
                    console.log('Trying with minimal constraints...');
                    localStream = await navigator.mediaDevices.getUserMedia({
                        video: {
                            width: { ideal: 640 },
                            height: { ideal: 480 },
                            facingMode: "user"
                        },
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true
                        }
                    });
                    
                    if (localVideo) {
                        localVideo.srcObject = localStream;
                    }
                    
                    localVideoEnabled = true;
                    localAudioEnabled = true;
                    updateMediaButtons();
                    joinChat();
                } catch (finalError) {
                    console.error('Final attempt failed:', finalError);
                    updateConnectionStatus('disconnected', 'მედია წვდომის შეცდომა: მიკროფონი და კამერა არ არის ხელმისაწვდომი');
                    
                    // Create empty stream as fallback
                    localStream = new MediaStream();
                    localVideoEnabled = false;
                    localAudioEnabled = false;
                    updateMediaButtons();
                    
                    // Alert user with helpful message
                    alert('Could not access camera or microphone. Please check your device settings and browser permissions.\n\n' + 
                         'Make sure you allow video/audio permissions and no other app is using your camera/microphone.');
                    
                    // Still join the chat to allow text chat
                    joinChat();
                }
            }
        }
    }

    // Update media buttons UI
    function updateMediaButtons() {
        if (toggleVideoBtn) {
            toggleVideoBtn.classList.toggle('muted', !localVideoEnabled);
            toggleVideoBtn.innerHTML = localVideoEnabled ? 
                '<i class="fas fa-video"></i>' : 
                '<i class="fas fa-video-slash"></i>';
        }
        
        if (toggleAudioBtn) {
            toggleAudioBtn.classList.toggle('muted', !localAudioEnabled);
            toggleAudioBtn.innerHTML = localAudioEnabled ? 
                '<i class="fas fa-microphone"></i>' : 
                '<i class="fas fa-microphone-slash"></i>';
        }
    }

    // Join the chat
    function joinChat() {
        if (!CHAT_ID) {
            console.error('Cannot join chat: CHAT_ID is undefined');
            updateConnectionStatus('disconnected', 'Error: Chat ID is undefined');
            return;
        }
        
        console.log('Emitting join_chat event for chat ID:', CHAT_ID);
        socket.emit('join_chat', { chat_id: CHAT_ID });
    }

    // Handle chat joined event
    socket.on('chat_joined', (data) => {
        console.log('Chat joined event received:', data);
        
        // Update partner username
        if (data.username !== USERNAME && partnerUsernameLabel) {
            console.log('Updating partner username to:', data.partner);
            partnerUsernameLabel.textContent = data.partner;
        }
        
        // Create peer connection if it doesn't exist
        if (!peerConnection) {
            console.log('Creating new peer connection');
            createPeerConnection();
            
            // Create and send offer
            console.log('Creating offer');
            createOffer();
        }
    });

    // Create peer connection
    function createPeerConnection() {
        console.log('Initializing peer connection with ICE servers:', iceServers);
        try {
            peerConnection = new RTCPeerConnection(iceServers);
            
            // Add local tracks to the peer connection
            if (localStream) {
                console.log('Adding local tracks to peer connection');
                localStream.getTracks().forEach(track => {
                    peerConnection.addTrack(track, localStream);
                });
            } else {
                console.warn('No local stream available to add to peer connection');
            }
            
            // Handle ICE candidates
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log('Generated ICE candidate:', event.candidate);
                    socket.emit('ice_candidate', {
                        chat_id: CHAT_ID,
                        candidate: event.candidate
                    });
                }
            };
            
            // Handle ICE connection state changes
            peerConnection.oniceconnectionstatechange = () => {
                console.log('ICE connection state changed to:', peerConnection.iceConnectionState);
                
                if (peerConnection.iceConnectionState === 'connected' || 
                    peerConnection.iceConnectionState === 'completed') {
                    console.log('Connection established!');
                    updateConnectionStatus('connected', 'დაკავშირებულია!');
                    isConnected = true;
                    connectionAttempts = 0;
                } else if (peerConnection.iceConnectionState === 'failed' || 
                           peerConnection.iceConnectionState === 'disconnected' ||
                           peerConnection.iceConnectionState === 'closed') {
                    console.log('Connection failed or lost');
                    updateConnectionStatus('disconnected', 'დაკავშირება დაიკარგა. ვცდილობთ ხელახლა დაკავშირებას...');
                    
                    if (!isConnected && connectionAttempts < MAX_CONNECTION_ATTEMPTS) {
                        console.log(`Connection attempt ${connectionAttempts + 1} failed, retrying...`);
                        // Try to restart the connection
                        setTimeout(() => {
                            if (peerConnection) {
                                peerConnection.close();
                                peerConnection = null;
                            }
                            connectionAttempts++;
                            createPeerConnection();
                            createOffer();
                        }, 2000);
                    } else if (connectionAttempts >= MAX_CONNECTION_ATTEMPTS) {
                        updateConnectionStatus('disconnected', 'ვერ ვუკავშირდებით. გთხოვთ, სცადოთ თავიდან.');
                    }
                }
            };
            
            // Handle remote track
            peerConnection.ontrack = (event) => {
                console.log('Received remote track:', event.track.kind);
                if (remoteVideo) {
                    remoteVideo.srcObject = event.streams[0];
                }
                updateConnectionStatus('connected', 'დაკავშირებულია!');
                isConnected = true;
            };
        } catch (error) {
            console.error('Error creating peer connection:', error);
            updateConnectionStatus('disconnected', 'შეცდომა კავშირის შექმნისას: ' + error.message);
        }
    }

    // Create and send offer
    async function createOffer() {
        try {
            if (!peerConnection) {
                console.error('Cannot create offer: peer connection is null');
                return;
            }
            
            console.log('Creating offer...');
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            console.log('Setting local description...');
            await peerConnection.setLocalDescription(offer);
            
            console.log('Sending offer to partner...');
            socket.emit('offer', {
                chat_id: CHAT_ID,
                offer: peerConnection.localDescription
            });
        } catch (error) {
            console.error('Error creating offer:', error);
            updateConnectionStatus('disconnected', 'შეცდომა შეთავაზების შექმნისას');
        }
    }

    // Handle incoming offer
    socket.on('offer', async (data) => {
        console.log('Received offer from partner');
        
        if (!peerConnection) {
            console.log('Creating peer connection in response to offer');
            createPeerConnection();
        }
        
        try {
            console.log('Setting remote description (offer)');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            
            console.log('Creating answer...');
            const answer = await peerConnection.createAnswer();
            
            console.log('Setting local description (answer)');
            await peerConnection.setLocalDescription(answer);
            
            console.log('Sending answer to partner');
            socket.emit('answer', {
                chat_id: CHAT_ID,
                answer: peerConnection.localDescription
            });
        } catch (error) {
            console.error('Error handling offer:', error);
            updateConnectionStatus('disconnected', 'შეცდომა შეთავაზების დამუშავებისას');
        }
    });

    // Handle incoming answer
    socket.on('answer', async (data) => {
        console.log('Received answer from partner');
        
        try {
            if (!peerConnection) {
                console.error('Cannot handle answer: peer connection is null');
                return;
            }
            
            console.log('Setting remote description (answer)');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
        } catch (error) {
            console.error('Error handling answer:', error);
            updateConnectionStatus('disconnected', 'შეცდომა პასუხის დამუშავებისას');
        }
    });

    // Handle ICE candidate
    socket.on('ice_candidate', (data) => {
        console.log('Received ICE candidate from partner');
        
        if (peerConnection) {
            console.log('Adding ICE candidate to connection');
            peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
                .then(() => {
                    console.log('ICE candidate added successfully');
                })
                .catch(error => {
                    console.error('Error adding ICE candidate:', error);
                });
        } else {
            console.warn('Received ICE candidate but no peer connection exists');
        }
    });

    // Handle user leaving
    socket.on('user_left', (data) => {
        console.log('User left:', data);
        
        // Clear remote video
        if (remoteVideo) {
            remoteVideo.srcObject = null;
        }
        
        // Close peer connection
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        
        // Update status
        updateConnectionStatus('disconnected', 'პარტნიორი გავიდა ჩათიდან');
        
        // Show message
        alert(`${data.username} has left the chat. You can find a new partner or return to the home page.`);
    });

    // Toggle video
    if (toggleVideoBtn) {
        toggleVideoBtn.addEventListener('click', () => {
            if (!localStream) {
                console.warn('Cannot toggle video: no local stream');
                return;
            }
            
            const videoTracks = localStream.getVideoTracks();
            if (videoTracks.length === 0) {
                console.warn('No video tracks available');
                alert('No video tracks available. Your camera might not be accessible.');
                return;
            }
            
            localVideoEnabled = !localVideoEnabled;
            
            videoTracks.forEach(track => {
                track.enabled = localVideoEnabled;
            });
            
            // Update button state
            toggleVideoBtn.classList.toggle('muted', !localVideoEnabled);
            toggleVideoBtn.innerHTML = localVideoEnabled ? 
                '<i class="fas fa-video"></i>' : 
                '<i class="fas fa-video-slash"></i>';
        });
    } else {
        console.warn('Toggle video button not found');
    }

    // Toggle audio
    if (toggleAudioBtn) {
        toggleAudioBtn.addEventListener('click', () => {
            if (!localStream) {
                console.warn('Cannot toggle audio: no local stream');
                return;
            }
            
            const audioTracks = localStream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.warn('No audio tracks available');
                alert('No audio tracks available. Your microphone might not be accessible.');
                return;
            }
            
            localAudioEnabled = !localAudioEnabled;
            
            audioTracks.forEach(track => {
                track.enabled = localAudioEnabled;
            });
            
            // Update button state
            toggleAudioBtn.classList.toggle('muted', !localAudioEnabled);
            toggleAudioBtn.innerHTML = localAudioEnabled ? 
                '<i class="fas fa-microphone"></i>' : 
                '<i class="fas fa-microphone-slash"></i>';
        });
    } else {
        console.warn('Toggle audio button not found');
    }

    // Screen sharing
    if (shareScreenBtn) {
        shareScreenBtn.addEventListener('click', async () => {
            try {
                if (!isScreenSharing) {
                    // Start screen sharing
                    console.log('Starting screen sharing...');
                    
                    try {
                        screenStream = await navigator.mediaDevices.getDisplayMedia({
                            video: true
                        });
                    } catch (e) {
                        console.error('Error getting display media:', e);
                        alert('Could not share screen: ' + e.message);
                        return;
                    }
                    
                    // Get video track from screen stream
                    const videoTrack = screenStream.getVideoTracks()[0];
                    if (!videoTrack) {
                        console.error('No video track in screen stream');
                        return;
                    }
                    
                    // Replace track in peer connection
                    if (peerConnection) {
                        const sender = peerConnection.getSenders().find(s => 
                            s.track && s.track.kind === 'video'
                        );
                        
                        if (sender) {
                            console.log('Replacing video track with screen track');
                            sender.replaceTrack(videoTrack);
                        } else {
                            console.warn('No video sender found in peer connection');
                        }
                    } else {
                        console.warn('No peer connection, cannot replace track');
                    }
                    
                    // Update local video display
                    if (localVideo) {
                        localVideo.srcObject = screenStream;
                    }
                    
                    // Listen for screen sharing end
                    videoTrack.onended = () => {
                        console.log('Screen sharing ended by browser');
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
                alert('Could not share screen. Please check your browser permissions.');
            }
        });
    } else {
        console.warn('Share screen button not found');
    }

    // Stop screen sharing
    function stopScreenSharing() {
        if (screenStream) {
            console.log('Stopping screen sharing');
            screenStream.getTracks().forEach(track => track.stop());
            
            // Replace screen track with camera track
            if (localStream && peerConnection) {
                const videoTrack = localStream.getVideoTracks()[0];
                
                const sender = peerConnection.getSenders().find(s => 
                    s.track && s.track.kind === 'video'
                );
                
                if (sender && videoTrack) {
                    console.log('Replacing screen track with camera track');
                    sender.replaceTrack(videoTrack);
                }
            }
            
            // Update local video display
            if (localVideo && localStream) {
                localVideo.srcObject = localStream;
            }
            
            isScreenSharing = false;
            if (shareScreenBtn) {
                shareScreenBtn.innerHTML = '<i class="fas fa-desktop"></i>';
                shareScreenBtn.classList.remove('muted');
            }
        }
    }

    // Function to restart a failed connection
    function restartConnection() {
        console.log('Attempting to restart connection...');
        updateConnectionStatus('connecting', 'ვცდილობთ ხელახლა დაკავშირებას...');
        
        // Close existing connection if any
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        
        // Create new connection and offer
        createPeerConnection();
        createOffer();
    }

    // Add a manual reconnect button
    const reconnectBtn = document.createElement('button');
    reconnectBtn.className = 'btn btn-warning mt-2';
    reconnectBtn.textContent = 'ხელახლა დაკავშირება';
    reconnectBtn.style.display = 'none';
    
    if (connectionStatus) {
        connectionStatus.after(reconnectBtn);
        
        reconnectBtn.addEventListener('click', () => {
            restartConnection();
        });
        
        // Show reconnect button when connection fails
        setInterval(() => {
            if (peerConnection && (peerConnection.iceConnectionState === 'failed' || 
                                 peerConnection.iceConnectionState === 'disconnected')) {
                reconnectBtn.style.display = 'block';
            } else {
                reconnectBtn.style.display = 'none';
            }
        }, 1000);
    }

    // Handle beforeunload event
    window.addEventListener('beforeunload', () => {
        // Leave chat room
        console.log('Leaving chat and closing connection...');
        if (CHAT_ID) {
            socket.emit('leave_chat', { chat_id: CHAT_ID });
        }
        
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
    console.log('Initializing video chat for chat ID:', CHAT_ID);
    initDevices();
});