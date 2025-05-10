// Text chat functionality
document.addEventListener('DOMContentLoaded', () => {
    const socket = io();
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendMessageBtn = document.getElementById('send-message');

    // Join the chat
    socket.emit('join_chat', { chat_id: CHAT_ID });

    // Handle incoming chat messages
    socket.on('chat_message', (data) => {
        const { username, message } = data;
        addMessageToChat(username, message, username === USERNAME);
    });

    // Send message
    function sendMessage() {
        const message = chatInput.value.trim();
        if (message) {
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
        addMessageToChat('System', 'Chat started. Say hello to your partner!', false);
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