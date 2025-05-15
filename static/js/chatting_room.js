// Initialize Socket.IO connection
const socket = io();

document.addEventListener('DOMContentLoaded', function() {
    // Cache DOM elements
    const chatMessages = document.getElementById('chat-messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const sendMessageBtn = document.getElementById('send-message');
    const copyInviteBtn = document.getElementById('copy-invite-code');
    const participantsSidebar = document.getElementById('participants-sidebar');
    const toggleParticipantsBtn = document.getElementById('toggle-participants');
    
    // Get room data from the data attribute
    const roomDataEl = document.getElementById('room-data');
    if (!roomDataEl) {
        console.error('Room data element not found');
        return;
    }
    
    const ROOM_CODE = roomDataEl.getAttribute('data-room-code');
    const USER_ID = parseInt(roomDataEl.getAttribute('data-user-id'));
    const USERNAME = roomDataEl.getAttribute('data-username');
    const IS_ADMIN = roomDataEl.getAttribute('data-is-admin') === '1';
    
    // Initialize Bootstrap modals if they exist
    const confirmRemoveModal = document.getElementById('confirmRemoveModal') ? 
                             new bootstrap.Modal(document.getElementById('confirmRemoveModal')) : null;
    const confirmAdminModal = document.getElementById('confirmAdminModal') ? 
                             new bootstrap.Modal(document.getElementById('confirmAdminModal')) : null;
    
    // Modal elements
    const confirmRemoveBtn = document.getElementById('confirm-remove-btn');
    const removeUsername = document.getElementById('remove-username');
    const confirmAdminBtn = document.getElementById('confirm-admin-btn');
    const adminUsername = document.getElementById('admin-username');
    
    let targetUserId = null;
    
    // Join the chatroom
    socket.emit('join_chatroom', { room_code: ROOM_CODE });
    
    // Listen for participants update
    socket.on('chatroom_participants', function(data) {
        updateParticipantsUI(data.participants);
    });
    
    // Listen for chat messages
    socket.on('chatroom_message', function(data) {
        addMessageToChat(data);
        
        // Scroll to bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
    
    // Listen for user kicked event
    socket.on('kicked_from_chatroom', function(data) {
        if (data.room_code === ROOM_CODE) {
            alert('თქვენ გაგაძევეს ჩატიდან');
            window.location.href = '/chatting';
        }
    });
    
    // Send message on form submit
    if (chatForm) {
        chatForm.addEventListener('submit', function(e) {
            e.preventDefault();
            sendMessage();
        });
    }
    
    // Alternative: Send message on button click
    if (sendMessageBtn) {
        sendMessageBtn.addEventListener('click', function() {
            if (!chatForm) { // Only handle click if not in a form
                sendMessage();
            }
        });
    }
    
    // Function to send a message
    function sendMessage() {
        if (!chatInput) return;
        
        const message = chatInput.value.trim();
        if (message) {
            console.log('Sending message:', message);
            
            socket.emit('send_chatroom_message', {
                room_code: ROOM_CODE,
                message: message
            });
            
            chatInput.value = '';
            chatInput.focus();
        }
    }
    
    // Copy invite code button
    if (copyInviteBtn) {
        copyInviteBtn.addEventListener('click', function() {
            const inviteCode = ROOM_CODE;
            
            navigator.clipboard.writeText(inviteCode)
                .then(function() {
                    copyInviteBtn.innerHTML = '<i class="fas fa-check"></i>';
                    setTimeout(function() {
                        copyInviteBtn.innerHTML = '<i class="fas fa-copy"></i>';
                    }, 2000);
                })
                .catch(function(err) {
                    console.error('Failed to copy code: ', err);
                    alert('კოდის კოპირება ვერ მოხერხდა');
                });
        });
    }
    
    // Toggle participants sidebar on mobile
    if (toggleParticipantsBtn && participantsSidebar) {
        toggleParticipantsBtn.addEventListener('click', function() {
            participantsSidebar.classList.toggle('show');
            
            // Update button text based on visibility
            if (participantsSidebar.classList.contains('show')) {
                toggleParticipantsBtn.innerHTML = '<i class="fas fa-times"></i> დამალვა';
            } else {
                toggleParticipantsBtn.innerHTML = '<i class="fas fa-user-friends"></i> მონაწილეების ჩვენება';
            }
        });
    }
    
    // Setup event handlers for admin actions
    setupAdminControls();
    
    // Scroll to bottom of chat on load
    if (chatMessages) {
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    // Focus input field
    if (chatInput) {
        chatInput.focus();
    }
    
    // Function to add message to chat
    function addMessageToChat(data) {
        if (!chatMessages) return;
        
        const messageDiv = document.createElement('div');
        
        if (data.type === 'system') {
            messageDiv.className = 'chat-message chat-message-system';
            messageDiv.innerHTML = 
                '<div class="message-bubble message-bubble-system">' +
                '<div class="message-content">' + data.content + '</div>' +
                '</div>';
        } else {
            const isSelf = data.user_id === USER_ID;
            messageDiv.className = 'chat-message ' + (isSelf ? 'chat-message-self' : 'chat-message-other');
            
            let senderHTML = '';
            if (!isSelf) {
                senderHTML = '<div class="message-sender">' + data.username + '</div>';
            }
            
            messageDiv.innerHTML = 
                senderHTML +
                '<div class="message-bubble ' + (isSelf ? 'message-bubble-self' : 'message-bubble-other') + '">' +
                '<div class="message-content">' + data.content + '</div>' +
                '<div class="message-time">' + formatTime(data.timestamp) + '</div>' +
                '</div>';
        }
        
        chatMessages.appendChild(messageDiv);
    }
    
    // Function to update participants UI
    function updateParticipantsUI(participants) {
        if (!participantsSidebar) return;
        
        const participantsList = participantsSidebar.querySelector('.participants-list');
        if (!participantsList) return;
        
        participantsList.innerHTML = '';
        
        participants.forEach(function(participant) {
            const participantItem = document.createElement('div');
            participantItem.className = 'participant-item';
            
            let adminBadge = '';
            if (participant.is_admin) {
                adminBadge = '<span class="admin-badge">ადმინი</span>';
            }
            
            let selfIndicator = '';
            if (participant.id === USER_ID) {
                selfIndicator = '<span class="text-muted">(თქვენ)</span>';
            }
            
            let adminControls = '';
            if (IS_ADMIN && participant.id !== USER_ID) {
                adminControls = 
                    '<div class="participant-actions">' +
                    '<button class="make-admin-btn" data-user-id="' + participant.id + '" title="ადმინის მინიჭება">' +
                    '<i class="fas fa-user-shield"></i>' +
                    '</button>' +
                    '<button class="remove-user-btn" data-user-id="' + participant.id + '" title="ამოშლა">' +
                    '<i class="fas fa-times"></i>' +
                    '</button>' +
                    '</div>';
            }
            
            participantItem.innerHTML = 
                '<div class="participant-info">' +
                '<div class="participant-avatar">' +
                participant.username.charAt(0).toUpperCase() +
                '</div>' +
                '<div>' +
                participant.username +
                adminBadge +
                selfIndicator +
                '</div>' +
                '</div>' +
                adminControls;
            
            participantsList.appendChild(participantItem);
        });
        
        // Reattach event handlers for the new participant elements
        setupAdminControls();
    }
    
    // Function to set up admin control buttons
    function setupAdminControls() {
        // Handle remove user buttons
        document.querySelectorAll('.remove-user-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                targetUserId = this.getAttribute('data-user-id');
                const username = this.closest('.participant-item').querySelector('.participant-info div').textContent.trim();
                
                if (removeUsername) {
                    removeUsername.textContent = username;
                }
                
                if (confirmRemoveModal) {
                    confirmRemoveModal.show();
                } else {
                    if (confirm('დარწმუნებული ხართ, რომ გსურთ ' + username + '-ის ამოშლა?')) {
                        socket.emit('kick_user', {
                            room_code: ROOM_CODE,
                            user_id: targetUserId
                        });
                        targetUserId = null;
                    }
                }
            });
        });
        
        // Handle make admin buttons
        document.querySelectorAll('.make-admin-btn').forEach(function(btn) {
            btn.addEventListener('click', function() {
                targetUserId = this.getAttribute('data-user-id');
                const username = this.closest('.participant-item').querySelector('.participant-info div').textContent.trim();
                
                if (adminUsername) {
                    adminUsername.textContent = username;
                }
                
                if (confirmAdminModal) {
                    confirmAdminModal.show();
                } else {
                    if (confirm('დარწმუნებული ხართ, რომ გსურთ ' + username + '-ისთვის ადმინის უფლებების მინიჭება?')) {
                        // Make AJAX request to toggle admin status
                        fetch('/chatting/manage/' + ROOM_CODE, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/x-www-form-urlencoded',
                            },
                            body: 'action=toggle_admin&participant_id=' + targetUserId
                        })
                        .then(function(response) {
                            if (response.ok) {
                                location.reload();
                            } else {
                                alert('ადმინის სტატუსის შეცვლა ვერ მოხერხდა');
                            }
                        })
                        .catch(function(error) {
                            console.error('Error:', error);
                            alert('ადმინის სტატუსის შეცვლა ვერ მოხერხდა');
                        });
                        targetUserId = null;
                    }
                }
            });
        });
    }
    
    // Set up modal confirm buttons
    if (confirmRemoveBtn) {
        confirmRemoveBtn.addEventListener('click', function() {
            if (targetUserId) {
                socket.emit('kick_user', {
                    room_code: ROOM_CODE,
                    user_id: targetUserId
                });
                
                confirmRemoveModal.hide();
                targetUserId = null;
            }
        });
    }
    
    if (confirmAdminBtn) {
        confirmAdminBtn.addEventListener('click', function() {
            if (targetUserId) {
                // Make AJAX request to toggle admin status
                fetch('/chatting/manage/' + ROOM_CODE, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: 'action=toggle_admin&participant_id=' + targetUserId
                })
                .then(function(response) {
                    if (response.ok) {
                        location.reload();
                    } else {
                        alert('ადმინის სტატუსის შეცვლა ვერ მოხერხდა');
                    }
                })
                .catch(function(error) {
                    console.error('Error:', error);
                    alert('ადმინის სტატუსის შეცვლა ვერ მოხერხდა');
                });
                
                confirmAdminModal.hide();
                targetUserId = null;
            }
        });
    }
    
    // Helper function to format timestamp
    function formatTime(timestamp) {
        if (!timestamp) {
            return new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        }
        const date = new Date(timestamp * 1000);
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return hours + ':' + minutes;
    }
    
    // Before unload handler
    window.addEventListener('beforeunload', function() {
        socket.emit('leave_chatroom', { room_code: ROOM_CODE });
    });
});