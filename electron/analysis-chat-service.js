function createChatService() {
  const chatService = {};

  // Initialize chat service
  chatService.init = async (token) => {
    if (!token) {
      throw new Error("Token is required");
    }

    try {
      const response = await fetch('/api/v1/chat', {
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json'
        },
      });

      const data = await response.json();
      return data;
    } catch (error) {
      throw new Error('Failed to get chat');
    }
  };

  // Handle incoming messages
  chatService.receiveMessage = async (message, userId) => {
    if (!message || !userId) {
      throw new Error("Invalid message or user ID");
    }

    try {
      const response = await fetch('/api/v1/chat/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message, userId }),
      });

      const data = await response.json();
      return data;
    } catch (error) {
      throw new Error('Failed to receive message');
    }
  };

  // Authenticate user
  chatService.authenticate = async (username, password) => {
    if (!username || !password) {
      throw new Error("Invalid username or password");
    }

    try {
      const response = await fetch('/api/v1/chat/authenticate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username, password }),
      });

      const data = await response.json();
      return data;
    } catch (error) {
      throw new Error('Failed to authenticate');
    }
  };

  // Get chat history
  chatService.getHistory = async (userId) => {
    if (!userId) {
      throw new Error("Invalid user ID");
    }

    try {
      const response = await fetch('/api/v1/chat/history', {
        headers: {
          'Content-Type': 'application/json'
        },
      });

      const data = await response.json();
      return data;
    } catch (error) {
      throw new Error('Failed to get chat history');
    }
  };

  // Send message
  chatService.sendMessage = async (message, userId) => {
    if (!message || !userId) {
      throw new Error("Invalid message or user ID");
    }

    try {
      const response = await fetch('/api/v1/chat/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ message, userId }),
      });

      const data = await response.json();
      return data;
    } catch (error) {
      throw new Error('Failed to send message');
    }
  };

  // Add event listeners
  chatService.onMessageReceived = (message) => {
    console.log(`New message received: ${message}`);
  };

  return chatService;
}

export default createChatService;