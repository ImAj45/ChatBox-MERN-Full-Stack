// server.js - Main server file
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mysql = require('mysql2/promise');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MySQL Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'chat_app',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Database initialization
async function initDatabase() {
  try {
    const connection = await pool.getConnection();

    // Use a safe DB name (backtick-quoted)
    const dbName = process.env.DB_NAME || 'chat_app';
    await connection.execute(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await connection.execute(`USE \`${dbName}\``);

    // Create tables
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        display_name VARCHAR(100),
        avatar_url VARCHAR(255),
        is_anonymous BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS chat_rooms (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        created_by INT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id INT NOT NULL,
        user_id INT,
        username VARCHAR(50),
        message TEXT NOT NULL,
        is_anonymous BOOLEAN DEFAULT FALSE,
        message_type ENUM('text', 'image', 'file') DEFAULT 'text',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (room_id) REFERENCES chat_rooms(id),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS room_members (
        id INT AUTO_INCREMENT PRIMARY KEY,
        room_id INT NOT NULL,
        user_id INT NOT NULL,
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_online BOOLEAN DEFAULT FALSE,
        FOREIGN KEY (room_id) REFERENCES chat_rooms(id),
        FOREIGN KEY (user_id) REFERENCES users(id),
        UNIQUE KEY unique_room_user (room_id, user_id)
      )
    `);

    // Insert sample data (use INSERT IGNORE to avoid duplicates)
    await connection.execute(`
      INSERT IGNORE INTO users (username, display_name, is_anonymous) VALUES 
      ('anonymous1', 'Anonymous', true),
      ('anonymous2', 'Anonymous', true),
      ('anonymous3', 'Anonymous', true),
      ('abhay_shukla', 'Abhay Shukla', false)
    `);

    await connection.execute(`
      INSERT IGNORE INTO chat_rooms (id, name, description, created_by) VALUES 
      (1, 'Fun Friday Group', 'Weekly fun activities and discussions', 4)
    `);

    await connection.execute(`
      INSERT IGNORE INTO room_members (room_id, user_id, is_online) VALUES 
      (1, 1, true),
      (1, 2, true),
      (1, 3, true),
      (1, 4, true)
    `);

    connection.release();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get chat room info
app.get('/api/room/:roomId', async (req, res) => {
  try {
    const [rooms] = await pool.execute(
      'SELECT * FROM chat_rooms WHERE id = ?',
      [req.params.roomId]
    );

    if (rooms.length === 0) {
      return res.status(404).json({ error: 'Room not found' });
    }

    const [members] = await pool.execute(`
      SELECT u.id, u.username, u.display_name, u.is_anonymous, rm.is_online
      FROM room_members rm
      JOIN users u ON rm.user_id = u.id
      WHERE rm.room_id = ?
    `, [req.params.roomId]);

    res.json({
      room: rooms[0],
      members: members
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get messages for a room
app.get('/api/room/:roomId/messages', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const [messages] = await pool.execute(`
      SELECT m.*, u.display_name, u.avatar_url
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.room_id = ?
      ORDER BY m.created_at DESC
      LIMIT ? OFFSET ?
    `, [req.params.roomId, limit, offset]);

    res.json(messages.reverse());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Post a new message via REST
app.post('/api/room/:roomId/messages', async (req, res) => {
  try {
    const { userId, message, isAnonymous, messageType = 'text' } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message cannot be empty' });
    }

    let username = 'Anonymous';
    if (!isAnonymous && userId) {
      const [users] = await pool.execute(
        'SELECT username, display_name FROM users WHERE id = ?',
        [userId]
      );
      if (users.length > 0) {
        username = users[0].display_name || users[0].username;
      }
    }

    const [result] = await pool.execute(`
      INSERT INTO messages (room_id, user_id, username, message, is_anonymous, message_type)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [req.params.roomId, userId || null, username, message.trim(), !!isAnonymous, messageType]);

    const [newMessage] = await pool.execute(`
      SELECT m.*, u.display_name, u.avatar_url
      FROM messages m
      LEFT JOIN users u ON m.user_id = u.id
      WHERE m.id = ?
    `, [result.insertId]);

    // Emit to all connected clients in the room
    io.to(`room_${req.params.roomId}`).emit('new_message', newMessage[0]);

    res.status(201).json(newMessage[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create or join user
app.post('/api/users', async (req, res) => {
  try {
    const { username, displayName, isAnonymous = false } = req.body;

    const [result] = await pool.execute(`
      INSERT INTO users (username, display_name, is_anonymous)
      VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      is_anonymous = VALUES(is_anonymous),
      last_seen = CURRENT_TIMESTAMP
    `, [username, displayName, isAnonymous]);

    // If insertId is zero (duplicate), fetch user row
    const [user] = await pool.execute(
      'SELECT * FROM users WHERE username = ?',
      [username]
    );

    res.json(user[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join a room
  socket.on('join_room', async (data) => {
    const { roomId, userId } = data;
    socket.join(`room_${roomId}`);

    // Update user online status
    if (userId) {
      try {
        await pool.execute(`
          INSERT INTO room_members (room_id, user_id, is_online)
          VALUES (?, ?, true)
          ON DUPLICATE KEY UPDATE is_online = true
        `, [roomId, userId]);
      } catch (error) {
        console.error('Error updating online status:', error);
      }
    }

    socket.emit('joined_room', { roomId });
    socket.to(`room_${roomId}`).emit('user_joined', { userId });
  });

  // Handle new messages
  socket.on('send_message', async (data) => {
    const { roomId, userId, message, isAnonymous } = data;

    try {
      let username = 'Anonymous';
      if (!isAnonymous && userId) {
        const [users] = await pool.execute(
          'SELECT username, display_name FROM users WHERE id = ?',
          [userId]
        );
        if (users.length > 0) {
          username = users[0].display_name || users[0].username;
        }
      }

      const [result] = await pool.execute(`
        INSERT INTO messages (room_id, user_id, username, message, is_anonymous)
        VALUES (?, ?, ?, ?, ?)
      `, [roomId, userId || null, username, message, !!isAnonymous]);

      const messageData = {
        id: result.insertId,
        room_id: roomId,
        user_id: userId || null,
        username,
        message,
        is_anonymous: !!isAnonymous,
        created_at: new Date()
      };

      io.to(`room_${roomId}`).emit('new_message', messageData);
    } catch (error) {
      socket.emit('error', { message: 'Failed to send message' });
    }
  });

  // Handle typing indicators
  socket.on('typing_start', (data) => {
    socket.to(`room_${data.roomId}`).emit('user_typing', {
      userId: data.userId,
      username: data.username
    });
  });

  socket.on('typing_stop', (data) => {
    socket.to(`room_${data.roomId}`).emit('user_stop_typing', {
      userId: data.userId
    });
  });

  // Handle disconnect
  socket.on('disconnect', async () => {
    console.log('User disconnected:', socket.id);
    // In a real app you'd update the user's online status here
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
const PORT = process.env.PORT || 3000;

initDatabase().then(() => {
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Visit http://localhost:${PORT} to use the chat app`);
  });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});