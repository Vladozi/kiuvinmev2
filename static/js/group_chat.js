// WebRTC group video chat handling - Part 1
document.addEventListener('DOMContentLoaded', () => {
    // Global variables
    const socket = io();
    const videoGrid = document.getElementById('video-grid');
    const localVideoContainer = document.getElementById('local-container');
    const localVideo = document.getElementById('local-video');
    const toggleVideoBtn = document.getElementById('toggle-video');
    const toggleAudioBtn = document.getElementById('toggle-audio');
    const shareScreenBtn = document.getElementById('share-screen');
    const startRecordingBtn = document.getElementById('start-recording');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendMessageBtn = document.getElementById('send-message');
    const participantsList = document.getElementById('participants-list');
    const participantCount = document.getElementById('participant-count');
    const recordingStatus = document.getElementById('recording-status');
    
    // Set up bootstrap modal
    let recordingModal;
    if (document.getElementById('recording-modal')) {
        recordingModal = new bootstrap.Modal(document.getElementById('recording-modal'));
    } else {
        console.warn('Recording modal element not found');
    }
    
    const copyRoomCodeBtn = document.getElementById('copy-room-code');
    
    // Ensure ROOM_ID is defined
    if (typeof ROOM_ID === 'undefined' || !ROOM_ID) {
        console.error('ROOM_ID is not defined!');
        
        // Check if we can get ROOM_ID from the URL or data attribute
        const urlMatch = window.location.pathname.match(/\/room\/([A-Z0-9]+)/);
        if (urlMatch && urlMatch[1]) {
            window.ROOM_ID = urlMatch[1];
            console.log('ROOM_ID extracted from URL:', window.ROOM_ID);
        } else {
            // Try getting from room-data element
            const roomDataEl = document.getElementById('room-data');
            if (roomDataEl && roomDataEl.getAttribute('data-room-id')) {
                window.ROOM_ID = roomDataEl.getAttribute('data-room-id');
                console.log('ROOM_ID extracted from data attribute:', window.ROOM_ID);
            } else {
                alert('Room ID could not be determined. Please refresh the page or try joining again.');
                console.error('Could not determine ROOM_ID, critical error!');
            }
        }
    }
    
    // Store peer connections, streams and statuses
    let localStream = null;
    let screenStream = null;
    let isScreenSharing = false;
    let localVideoEnabled = true;
    let localAudioEnabled = true;
    let isRecording = false;
    let mediaRecorder = null;
    let recordedChunks = [];
    let peerConnections = {};
    
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
    
    // Initialize media devices with better error handling
    async function initDevices() {
        try {
            console.log('Requesting media permissions...');
            
            // Request both audio and video with less restrictive constraints
            localStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    width: { ideal: 1280 },
                    height: { ideal: 720 },
                    facingMode: "user"
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true
                }
            });
            
            console.log('Media permissions granted, displaying local video');
            
            // Display local video
            if (localVideo) {
                localVideo.srcObject = localStream;
            } else {
                console.error('Local video element not found!');
            }
            
            // Set up UI for media state
            updateMediaButtons();
            
            // Join the room after getting media
            joinRoom();
            
        } catch (error) {
            console.error('Error accessing media devices:', error);
            
            // Try to proceed with just audio if video fails
            try {
                console.log('Trying with just audio...');
                localStream = await navigator.mediaDevices.getUserMedia({
                    video: false,
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true
                    }
                });
                
                if (localVideo) {
                    localVideo.srcObject = localStream;
                    
                    // Add a video disabled overlay
                    const overlay = document.createElement('div');
                    overlay.classList.add('video-disabled-overlay');
                    overlay.style.position = 'absolute';
                    overlay.style.top = '0';
                    overlay.style.left = '0';
                    overlay.style.width = '100%';
                    overlay.style.height = '100%';
                    overlay.style.backgroundColor = 'rgba(0,0,0,0.7)';
                    overlay.style.color = 'white';
                    overlay.style.display = 'flex';
                    overlay.style.alignItems = 'center';
                    overlay.style.justifyContent = 'center';
                    overlay.textContent = 'Camera disabled';
                    
                    const container = localVideo.parentNode;
                    if (container) {
                        container.appendChild(overlay);
                    }
                }
                
                localVideoEnabled = false;
                localAudioEnabled = true;
                updateMediaButtons();
                joinRoom();
                
            } catch (audioError) {
                console.error('Could not access audio either:', audioError);
                
                try {
                    // Try with minimal constraints as last resort
                    console.log('Trying with minimal constraints...');
                    localStream = await navigator.mediaDevices.getUserMedia({
                        video: {
                            width: { ideal: 320 },
                            height: { ideal: 240 }
                        },
                        audio: true
                    });
                    
                    if (localVideo) {
                        localVideo.srcObject = localStream;
                    }
                    
                    localVideoEnabled = true;
                    localAudioEnabled = true;
                    updateMediaButtons();
                    joinRoom();
                    
                } catch (finalError) {
                    console.error('Final attempt failed:', finalError);
                    
                    // Create empty stream as fallback
                    localStream = new MediaStream();
                    localVideoEnabled = false;
                    localAudioEnabled = false;
                    updateMediaButtons();
                    
                    alert('Could not access camera or microphone. Please check your device settings and browser permissions.');
                    
                    // Still join the room for text chat at least
                    joinRoom();
                }
            }
        }
    }
    
    // Update UI for media buttons
    function updateMediaButtons() {
        // Update video button
        if (toggleVideoBtn) {
            toggleVideoBtn.classList.toggle('muted', !localVideoEnabled);
            toggleVideoBtn.innerHTML = localVideoEnabled ? 
                '<i class="fas fa-video"></i>' : 
                '<i class="fas fa-video-slash"></i>';
        }
        
        // Update audio button
        if (toggleAudioBtn) {
            toggleAudioBtn.classList.toggle('muted', !localAudioEnabled);
            toggleAudioBtn.innerHTML = localAudioEnabled ? 
                '<i class="fas fa-microphone"></i>' : 
                '<i class="fas fa-microphone-slash"></i>';
        }
    }
    
    // Join the room
    function joinRoom() {
        // Make sure we have a valid ROOM_ID
        const roomId = window.ROOM_ID || ROOM_ID;
        if (!roomId) {
            console.error('Cannot join room: Room ID is undefined');
            alert('Error: Room ID is undefined. Please refresh the page or try joining again.');
            return;
        }
        
        console.log('Joining room:', roomId);
        
        // Emit join_group_room event to the server
        socket.emit('join_group_room', { 
            room_id: roomId
        });
    }
    
    // Handle group room participants update
    socket.on('group_room_participants', (data) => {
        console.log('Room participants updated:', data.participants);
        
        // Update participants count
        if (participantCount) {
            participantCount.textContent = data.participants.length;
        }
        
        // Update participants list
        updateParticipantsList(data.participants);
        
        // Create peer connections with new participants
        handleParticipantsChange(data.participants);
    });
    
    // Update the participants list in the UI
    function updateParticipantsList(participants) {
        if (!participantsList) return;
        
        participantsList.innerHTML = '';
        
        participants.forEach(participant => {
            const participantItem = document.createElement('div');
            participantItem.className = 'participant-item';
            participantItem.dataset.userId = participant.id;
            
            participantItem.innerHTML = `
                <div class="participant-name">
                    ${participant.username}
                    ${participant.is_host ? '<span class="host-badge">Host</span>' : ''}
                    ${participant.id == USER_ID ? ' (You)' : ''}
                </div>
            `;
            
            // Add host controls if current user is host
            if (IS_HOST && participant.id != USER_ID) {
                const removeBtn = document.createElement('button');
                removeBtn.className = 'btn btn-sm btn-outline-danger';
                removeBtn.innerHTML = '<i class="fas fa-times"></i>';
                removeBtn.addEventListener('click', () => {
                    if (confirm(`Are you sure you want to remove ${participant.username} from the room?`)) {
                        socket.emit('remove_participant', {
                            room_id: window.ROOM_ID || ROOM_ID,
                            target_id: participant.id
                        });
                    }
                });
                
                participantItem.appendChild(removeBtn);
            }
            
            participantsList.appendChild(participantItem);
        });
    }
    
    // Handle participants change
    function handleParticipantsChange(participants) {
        // Get list of current participant IDs (excluding self)
        const currentParticipantIds = participants
            .filter(p => p.id != USER_ID)
            .map(p => p.id);
        
        // Get list of existing peer connection IDs
        const existingPeerIds = Object.keys(peerConnections).map(Number);
        
        // Find new participants to connect to
        const newParticipantIds = currentParticipantIds.filter(
            id => !existingPeerIds.includes(id)
        );
        
        // Find old participants to disconnect from
        const disconnectedParticipantIds = existingPeerIds.filter(
            id => !currentParticipantIds.includes(id)
        );
        
        console.log('New participants:', newParticipantIds);
        console.log('Disconnected participants:', disconnectedParticipantIds);
        
        // Create connections with new participants
        newParticipantIds.forEach(participantId => {
            const participant = participants.find(p => p.id === participantId);
            if (participant) {
                createPeerConnection(participantId, participant.username);
            }
        });
        
        // Clean up disconnected peer connections
        disconnectedParticipantIds.forEach(participantId => {
            cleanupPeerConnection(participantId);
        });
    }
    
    // Create a peer connection with a participant
    function createPeerConnection(participantId, participantUsername) {
        console.log('Creating peer connection with participant:', participantId);
        
        try {
            // Create new RTCPeerConnection
            const peerConnection = new RTCPeerConnection(iceServers);
            
            // Store the peer connection
            peerConnections[participantId] = {
                connection: peerConnection,
                username: participantUsername
            };
            
            // Add local tracks to the peer connection
            if (localStream) {
                localStream.getTracks().forEach(track => {
                    peerConnection.addTrack(track, localStream);
                });
            }
            
            // Handle ICE candidates
            peerConnection.onicecandidate = (event) => {
                if (event.candidate) {
                    console.log('Generated ICE candidate for peer:', participantId);
                    socket.emit('group_room_ice_candidate', {
                        room_id: window.ROOM_ID || ROOM_ID,
                        target_id: participantId,
                        candidate: event.candidate
                    });
                }
            };
            
            // Handle ICE connection state changes
            peerConnection.oniceconnectionstatechange = () => {
                console.log('ICE connection state with peer', participantId, ':', 
                          peerConnection.iceConnectionState);
                
                // Handle disconnected state
                if (peerConnection.iceConnectionState === 'disconnected' ||
                    peerConnection.iceConnectionState === 'failed' ||
                    peerConnection.iceConnectionState === 'closed') {
                    
                    console.log('Peer', participantId, 'disconnected');
                }
            };
            
            // Handle remote track
            peerConnection.ontrack = (event) => {
                console.log('Received remote track from peer:', participantId);
                
                // Check if video container already exists for this peer
                const existingContainer = document.querySelector(
                    `.video-container[data-peer-id="${participantId}"]`
                );
                
                if (!existingContainer && videoGrid) {
                    // Create new video container
                    const videoContainer = document.createElement('div');
                    videoContainer.className = 'video-container';
                    videoContainer.dataset.peerId = participantId;
                    
                    // Create video element
                    const videoElement = document.createElement('video');
                    videoElement.className = 'video-item';
                    videoElement.autoplay = true;
                    videoElement.playsInline = true;
                    videoElement.srcObject = event.streams[0];
                    
                    // Create user label
                    const userLabel = document.createElement('div');
                    userLabel.className = 'user-label';
                    userLabel.textContent = participantUsername;
                    
                    // Append elements to container
                    videoContainer.appendChild(videoElement);
                    videoContainer.appendChild(userLabel);
                    
                    // Append container to grid
                    videoGrid.appendChild(videoContainer);
                } else if (existingContainer) {
                    // Update existing video element
                    const videoElement = existingContainer.querySelector('video');
                    if (videoElement) {
                        videoElement.srcObject = event.streams[0];
                    }
                }
            };
            
            // Create and send offer
            createOffer(participantId, peerConnection);
            
        } catch (error) {
            console.error('Error creating peer connection:', error);
            alert('Could not establish connection with peer: ' + error.message);
        }
    }
    // WebRTC group video chat handling - Part 2
    
    // Create and send an offer to a peer
    async function createOffer(participantId, peerConnection) {
        try {
            console.log('Creating offer for peer:', participantId);
            
            const offer = await peerConnection.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true
            });
            
            await peerConnection.setLocalDescription(offer);
            
            console.log('Sending offer to peer:', participantId);
            socket.emit('group_room_offer', {
                room_id: window.ROOM_ID || ROOM_ID,
                target_id: participantId,
                offer: peerConnection.localDescription
            });
        } catch (error) {
            console.error('Error creating offer:', error);
        }
    }
    
    // Clean up peer connection
    function cleanupPeerConnection(participantId) {
        console.log('Cleaning up connection with peer:', participantId);
        
        // Close and remove peer connection
        if (peerConnections[participantId]) {
            if (peerConnections[participantId].connection) {
                peerConnections[participantId].connection.close();
            }
            delete peerConnections[participantId];
        }
        
        // Remove video container
        const videoContainer = document.querySelector(
            `.video-container[data-peer-id="${participantId}"]`
        );
        
        if (videoContainer) {
            videoContainer.remove();
        }
    }
    
    // Handle offer from a peer
    socket.on('group_room_offer', async (data) => {
        const senderId = data.sender_id;
        const senderUsername = data.sender_username;
        
        console.log('Received offer from peer:', senderId);
        
        // Create peer connection if it doesn't exist
        if (!peerConnections[senderId]) {
            console.log('Creating new peer connection in response to offer');
            
            try {
                const peerConnection = new RTCPeerConnection(iceServers);
                
                // Store the peer connection
                peerConnections[senderId] = {
                    connection: peerConnection,
                    username: senderUsername
                };
                
                // Add local tracks to the peer connection
                if (localStream) {
                    localStream.getTracks().forEach(track => {
                        peerConnection.addTrack(track, localStream);
                    });
                }
                
                // Handle ICE candidates
                peerConnection.onicecandidate = (event) => {
                    if (event.candidate) {
                        console.log('Generated ICE candidate for peer:', senderId);
                        socket.emit('group_room_ice_candidate', {
                            room_id: window.ROOM_ID || ROOM_ID,
                            target_id: senderId,
                            candidate: event.candidate
                        });
                    }
                };
                
                // Handle ICE connection state changes
                peerConnection.oniceconnectionstatechange = () => {
                    console.log('ICE connection state with peer', senderId, ':', 
                              peerConnection.iceConnectionState);
                };
                
                // Handle remote track
                peerConnection.ontrack = (event) => {
                    console.log('Received remote track from peer:', senderId);
                    
                    // Check if video container already exists for this peer
                    const existingContainer = document.querySelector(
                        `.video-container[data-peer-id="${senderId}"]`
                    );
                    
                    if (!existingContainer && videoGrid) {
                        // Create new video container
                        const videoContainer = document.createElement('div');
                        videoContainer.className = 'video-container';
                        videoContainer.dataset.peerId = senderId;
                        
                        // Create video element
                        const videoElement = document.createElement('video');
                        videoElement.className = 'video-item';
                        videoElement.autoplay = true;
                        videoElement.playsInline = true;
                        videoElement.srcObject = event.streams[0];
                        
                        // Create user label
                        const userLabel = document.createElement('div');
                        userLabel.className = 'user-label';
                        userLabel.textContent = senderUsername;
                        
                        // Append elements to container
                        videoContainer.appendChild(videoElement);
                        videoContainer.appendChild(userLabel);
                        
                        // Append container to grid
                        videoGrid.appendChild(videoContainer);
                    } else if (existingContainer) {
                        // Update existing video element
                        const videoElement = existingContainer.querySelector('video');
                        if (videoElement) {
                            videoElement.srcObject = event.streams[0];
                        }
                    }
                };
            } catch (error) {
                console.error('Error creating peer connection in response to offer:', error);
                return;
            }
        }
        
        const peerConnection = peerConnections[senderId].connection;
        
        try {
            console.log('Setting remote description (offer)');
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            
            console.log('Creating answer...');
            const answer = await peerConnection.createAnswer();
            
            console.log('Setting local description (answer)');
            await peerConnection.setLocalDescription(answer);
            
            console.log('Sending answer to peer:', senderId);
            socket.emit('group_room_answer', {
                room_id: window.ROOM_ID || ROOM_ID,
                target_id: senderId,
                answer: peerConnection.localDescription
            });
        } catch (error) {
            console.error('Error handling offer:', error);
        }
    });
    
    // Handle answer from a peer
    socket.on('group_room_answer', async (data) => {
        const senderId = data.sender_id;
        
        console.log('Received answer from peer:', senderId);
        
        if (peerConnections[senderId] && peerConnections[senderId].connection) {
            const peerConnection = peerConnections[senderId].connection;
            
            try {
                console.log('Setting remote description (answer)');
                await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            } catch (error) {
                console.error('Error handling answer:', error);
            }
        } else {
            console.warn('Received answer but no peer connection exists for:', senderId);
        }
    });
    
    // Handle ICE candidate from a peer
    socket.on('group_room_ice_candidate', (data) => {
        const senderId = data.sender_id;
        
        console.log('Received ICE candidate from peer:', senderId);
        
        if (peerConnections[senderId] && peerConnections[senderId].connection) {
            const peerConnection = peerConnections[senderId].connection;
            
            peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate))
                .then(() => {
                    console.log('ICE candidate added successfully');
                })
                .catch(error => {
                    console.error('Error adding ICE candidate:', error);
                });
        } else {
            console.warn('Received ICE candidate but no peer connection exists for:', senderId);
        }
    });
    
    // Handle participant removed event
    socket.on('participant_removed', (data) => {
        console.log('You have been removed from the room');
        alert('You have been removed from the room by the host.');
        window.location.href = '/group-chat';
    });
    
    // Handle group chat message
    socket.on('group_chat_message', (data) => {
        if (!chatMessages) return;
        
        console.log('Received chat message:', data);
        
        const messageElement = document.createElement('div');
        
        if (data.type === 'system') {
            messageElement.className = 'message message-system';
            messageElement.textContent = data.message;
        } else {
            // User message
            messageElement.className = `message ${data.user_id == USER_ID ? 'message-self' : 'message-user'}`;
            
            const usernameElement = document.createElement('div');
            usernameElement.style.fontWeight = 'bold';
            usernameElement.textContent = data.user_id == USER_ID ? 'You' : data.username;
            
            const textElement = document.createElement('div');
            textElement.textContent = data.message;
            
            messageElement.appendChild(usernameElement);
            messageElement.appendChild(textElement);
        }
        
        chatMessages.appendChild(messageElement);
        
        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
    
    // Handle recording started event
    socket.on('recording_started', (data) => {
        console.log('Recording started by:', data.by_user);
        
        if (data.by_user !== USERNAME) {
            // Show recording indicator
            if (recordingStatus) {
                recordingStatus.classList.remove('d-none');
            }
        }
    });
    
    // Handle recording stopped event
    socket.on('recording_stopped', (data) => {
        console.log('Recording stopped by:', data.by_user);
        
        if (data.by_user !== USERNAME) {
            // Hide recording indicator
            if (recordingStatus) {
                recordingStatus.classList.add('d-none');
            }
        }
    });
    
    // Toggle video
    if (toggleVideoBtn) {
        toggleVideoBtn.addEventListener('click', () => {
            if (!localStream) {
                console.warn('Cannot toggle video: no local stream');
                alert('No media stream available');
                return;
            }
            
            const videoTracks = localStream.getVideoTracks();
            if (videoTracks.length === 0) {
                console.warn('No video tracks in local stream');
                alert('Video is not available');
                return;
            }
            
            localVideoEnabled = !localVideoEnabled;
            
            videoTracks.forEach(track => {
                track.enabled = localVideoEnabled;
            });
            
            // Update button state
            updateMediaButtons();
        });
    }
    
    // Toggle audio
    if (toggleAudioBtn) {
        toggleAudioBtn.addEventListener('click', () => {
            if (!localStream) {
                console.warn('Cannot toggle audio: no local stream');
                alert('No media stream available');
                return;
            }
            
            const audioTracks = localStream.getAudioTracks();
            if (audioTracks.length === 0) {
                console.warn('No audio tracks in local stream');
                alert('Audio is not available');
                return;
            }
            
            localAudioEnabled = !localAudioEnabled;
            
            audioTracks.forEach(track => {
                track.enabled = localAudioEnabled;
            });
            
            // Update button state
            updateMediaButtons();
        });
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
                    
                    // Replace track in all peer connections
                    for (const peerId in peerConnections) {
                        const peerConnection = peerConnections[peerId].connection;
                        
                        const sender = peerConnection.getSenders().find(s => 
                            s.track && s.track.kind === 'video'
                        );
                        
                        if (sender) {
                            console.log('Replacing video track with screen track for peer:', peerId);
                            sender.replaceTrack(videoTrack);
                        }
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
    }
    
    // Stop screen sharing
    function stopScreenSharing() {
        if (screenStream) {
            console.log('Stopping screen sharing');
            screenStream.getTracks().forEach(track => track.stop());
            
            // Replace screen track with camera track in all peer connections
            if (localStream) {
                const videoTrack = localStream.getVideoTracks()[0];
                
                for (const peerId in peerConnections) {
                    const peerConnection = peerConnections[peerId].connection;
                    
                    const sender = peerConnection.getSenders().find(s => 
                        s.track && s.track.kind === 'video'
                    );
                    
                    if (sender && videoTrack) {
                        console.log('Replacing screen track with camera track for peer:', peerId);
                        sender.replaceTrack(videoTrack);
                    }
                }
                
                // Update local video display
                if (localVideo) {
                    localVideo.srcObject = localStream;
                }
            }
            
            isScreenSharing = false;
            if (shareScreenBtn) {
                shareScreenBtn.innerHTML = '<i class="fas fa-desktop"></i>';
                shareScreenBtn.classList.remove('muted');
            }
        }
    }
    
    // Start/stop recording
    if (startRecordingBtn) {
        startRecordingBtn.addEventListener('click', () => {
            if (!isRecording) {
                startRecording();
            } else {
                stopRecording();
            }
        });
    }
    
    // Start recording with improved error handling
    function startRecording() {
        try {
            // Ensure ROOM_ID is defined
            const roomId = window.ROOM_ID || ROOM_ID;
            if (!roomId) {
                console.error('Cannot start recording: ROOM_ID is not defined');
                alert('Error: Room ID is not defined. Cannot start recording.');
                return;
            }
            
            console.log('Starting recording with ROOM_ID:', roomId);
            
            // Create a stream from all video elements
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const videos = document.querySelectorAll('.video-item');
            
            if (videos.length === 0) {
                console.error('No videos to record');
                alert('No videos to record');
                return;
            }
            
            // Set canvas size based on number of videos
            const width = 1280;
            const height = 720;
            canvas.width = width;
            canvas.height = height;
            
            // Create canvas stream
            const canvasStream = canvas.captureStream(30);
            
            // Add audio tracks from all streams
            if (localStream) {
                localStream.getAudioTracks().forEach(track => {
                    canvasStream.addTrack(track);
                });
            }
            
            // Set up media recorder with appropriate options for browser compatibility
            let options;
            if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
                options = { mimeType: 'video/webm;codecs=vp9,opus' };
            } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) {
                options = { mimeType: 'video/webm;codecs=vp8,opus' };
            } else if (MediaRecorder.isTypeSupported('video/webm')) {
                options = { mimeType: 'video/webm' };
            } else {
                console.error('No suitable mime type supported for recording');
                alert('Your browser does not support recording. Please try a different browser.');
                return;
            }
            
            mediaRecorder = new MediaRecorder(canvasStream, options);
            
            mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    recordedChunks.push(event.data);
                }
            };
            
            mediaRecorder.onstop = () => {
                console.log('Media recorder stopped');
                
                // Create blob from chunks
                const blob = new Blob(recordedChunks, { type: 'video/webm' });
                
                // Upload the recording
                uploadRecording(blob);
            };
            
            // Start drawing frames to canvas
            const drawFrames = () => {
                if (!isRecording) return;
                
                // Clear canvas
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, width, height);
                
                // Calculate grid dimensions
                const count = videos.length;
                const rows = Math.ceil(Math.sqrt(count));
                const cols = Math.ceil(count / rows);
                const cellWidth = width / cols;
                const cellHeight = height / rows;
                
                // Draw each video to canvas
                videos.forEach((video, index) => {
                    try {
                        const row = Math.floor(index / cols);
                        const col = index % cols;
                        const x = col * cellWidth;
                        const y = row * cellHeight;
                        
                        ctx.drawImage(video, x, y, cellWidth, cellHeight);
                    } catch (e) {
                        console.error('Error drawing video to canvas:', e);
                    }
                });
                
                // Request next frame
                if (isRecording) {
                    requestAnimationFrame(drawFrames);
                }
            };
            
            // Start recording
            recordedChunks = [];
            mediaRecorder.start(1000);
            isRecording = true;
            
            // Start drawing frames
            drawFrames();
            
            // Update UI
            startRecordingBtn.innerHTML = '<i class="fas fa-stop-circle"></i>';
            startRecordingBtn.classList.add('muted');
            if (recordingStatus) {
                recordingStatus.classList.remove('d-none');
            }
            
            // Notify others
            socket.emit('start_recording', {
                room_id: roomId
            });
            
        } catch (error) {
            console.error('Error starting recording:', error);
            alert('Could not start recording: ' + error.message);
        }
    }
    
    // Stop recording
    function stopRecording() {
        if (mediaRecorder && isRecording) {
            console.log('Stopping recording...');
            
            mediaRecorder.stop();
            isRecording = false;
            
            // Update UI
            startRecordingBtn.innerHTML = '<i class="fas fa-record-vinyl"></i>';
            startRecordingBtn.classList.remove('muted');
            if (recordingStatus) {
                recordingStatus.classList.add('d-none');
            }
            
            // Notify others
            socket.emit('stop_recording', {
                room_id: window.ROOM_ID || ROOM_ID
            });
        }
    }
    
    // Upload recording
    function uploadRecording(blob) {
        console.log('Uploading recording...');
        
        // Create form data
        const formData = new FormData();
        formData.append('recording', blob, 'group-recording.webm');
        formData.append('room_id', window.ROOM_ID || ROOM_ID);
        
        // Show recording modal
        const downloadInfo = document.getElementById('recording-download-info');
        if (downloadInfo) {
            downloadInfo.innerHTML = `
                <div class="spinner-border text-primary" role="status">
                    <span class="visually-hidden">Processing...</span>
                </div>
                <p>Uploading and processing video...</p>
            `;
        }
        
        if (recordingModal) {
            recordingModal.show();
        }
        
        // Upload the recording
        fetch('/upload-recording', {
            method: 'POST',
            body: formData
        })
        .then(response => response.json())
        .then(data => {
            console.log('Upload response:', data);
            
            if (downloadInfo) {
                if (data.success) {
                    downloadInfo.innerHTML = `
                        <div class="alert alert-success">
                            <i class="fas fa-check-circle"></i> Recording uploaded successfully!
                        </div>
                        <p>Your recording will be available for 24 hours.</p>
                    `;
                } else {
                    downloadInfo.innerHTML = `
                        <div class="alert alert-danger">
                            <i class="fas fa-exclamation-circle"></i> Error: ${data.error || 'Unknown error'}
                        </div>
                        <p>Please try again later.</p>
                    `;
                }
            }
        })
        .catch(error => {
            console.error('Error uploading recording:', error);
            
            if (downloadInfo) {
                downloadInfo.innerHTML = `
                    <div class="alert alert-danger">
                        <i class="fas fa-exclamation-circle"></i> Error uploading recording
                    </div>
                    <p>Please try again later.</p>
                `;
            }
        });
    }
    
    // Send chat message
    function sendChatMessage() {
        if (!chatInput) return;
        
        const message = chatInput.value.trim();
        
        if (message) {
            console.log('Sending chat message:', message);
            
            socket.emit('group_chat_message', {
                room_id: window.ROOM_ID || ROOM_ID,
                message: message
            });
            
            chatInput.value = '';
            chatInput.focus();
        }
    }
    
    // Copy room code
    if (copyRoomCodeBtn) {
        copyRoomCodeBtn.addEventListener('click', () => {
            const roomCode = window.ROOM_ID || ROOM_ID;
            
            navigator.clipboard.writeText(roomCode)
                .then(() => {
                    copyRoomCodeBtn.title = 'Copied!';
                    copyRoomCodeBtn.innerHTML = '<i class="fas fa-check"></i>';
                    
                    setTimeout(() => {
                        copyRoomCodeBtn.title = 'Copy room code';
                        copyRoomCodeBtn.innerHTML = '<i class="fas fa-copy"></i>';
                    }, 2000);
                })
                .catch(err => {
                    console.error('Error copying room code:', err);
                    alert('Could not copy room code: ' + err.message);
                });
        });
    }
    
    // Set up event listeners
    if (sendMessageBtn) {
        sendMessageBtn.addEventListener('click', sendChatMessage);
    }
    
    if (chatInput) {
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendChatMessage();
            }
        });
    }
    
    // Handle beforeunload event
    window.addEventListener('beforeunload', () => {
        // Leave room
        const roomId = window.ROOM_ID || ROOM_ID;
        if (roomId) {
            socket.emit('leave_group_room', { room_id: roomId });
        }
        
        // Stop recording if active
        if (isRecording) {
            stopRecording();
        }
        
        // Stop screen sharing if active
        if (isScreenSharing) {
            stopScreenSharing();
        }
        
        // Close all peer connections
        for (const peerId in peerConnections) {
            if (peerConnections[peerId].connection) {
                peerConnections[peerId].connection.close();
            }
        }
        
        // Stop all tracks
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
    });
    
    // Initialize
    initDevices();
});