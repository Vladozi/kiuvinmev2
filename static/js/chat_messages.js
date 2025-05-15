// Text chat functionality
document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendMessageBtn = document.getElementById('send-message');

    console.log('Initializing chat messaging for chat ID:', CHAT_ID);

    // Join the chat
    console.log('Emitting join_chat event');
    socket.emit('join_chat', { chat_id: CHAT_ID });

    // Handle incoming chat messages
    socket.on('chat_message', (data) => {
        console.log('Received chat_message event:', data);
        const { username, message } = data;
        addMessageToChat(username, message, username === USERNAME);
    });

    // Handle chat_joined event to confirm connection
    socket.on('chat_joined', (data) => {
        console.log('Received chat_joined event:', data);
        
        // Send a system message when partner joins
        if (data.username !== USERNAME) {
            addMessageToChat('System', `${data.username} has joined the chat.`, false);
        }
    });

    // Send message
    function sendMessage() {
        const message = chatInput.value.trim();
        if (message) {
            console.log('Sending message:', message);
            
            // Emit the message to the server
            socket.emit('chat_message', {
                chat_id: CHAT_ID,
                message: message
            });
            
            // Clear the input
            chatInput.value = '';
            
            // Focus the input field
            chatInput.focus();
        }
    }

    // Add message to chat display
    function addMessageToChat(username, message, isSelf = false) {
        console.log('Adding message to chat display:', { username, message, isSelf });
        
        const messageElement = document.createElement('div');
        messageElement.className = `message ${isSelf ? 'message-self' : 'message-other'}`;
        
        const usernameElement = document.createElement('div');
        usernameElement.className = 'message-username';
        usernameElement.textContent = isSelf ? 'You' : username;
        usernameElement.style.fontWeight = 'bold';
        
        const textElement = document.createElement('div');
        textElement.className = 'message-text';
        textElement.textContent = message;
        
        messageElement.appendChild(usernameElement);
        messageElement.appendChild(textElement);
        chatMessages.appendChild(messageElement);
        
        // Scroll to the bottom
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    // Send welcome message
    setTimeout(() => {
        addMessageToChat('System', `Welcome to the chat! Your partner is ${PARTNER_USERNAME}.`, false);
    }, 1000);

    // Send message on button click
    sendMessageBtn.addEventListener('click', sendMessage);

    // Send message on Enter key
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });

    // Focus the input field when the page loads
    setTimeout(() => {
        chatInput.focus();
    }, 500);
});