const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Groq } = require('groq-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();

// Update the CORS configuration at the top of your server.js
const corsOptions = {
  origin: [
    'http://localhost:3000', 
    'http://localhost:3001',
    'https://deep-think.netlify.app' // Add your frontend domain if you have one
  ],
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 200 // Some legacy browsers (IE11, various SmartTVs) choke on 204
};

app.use(cors(corsOptions));
app.use(bodyParser.json());
app.use(express.json());

// Add OPTIONS handling for preflight requests
app.options('*', cors(corsOptions));

// Add this middleware to log all requests
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  console.log('Request body:', req.body);
  res.header('Access-Control-Allow-Origin', req.headers.origin);
  res.header('Access-Control-Allow-Credentials', true);
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  res.header(
    'Access-Control-Allow-Methods',
    'GET, POST, PUT, DELETE, OPTIONS'
  );
  next();
});

// Verify API keys
if (!process.env.GOOGLE_API_KEY) {
  console.error('GOOGLE_API_KEY is missing');
  process.exit(1);
}

if (!process.env.GROQ_API_KEY) {
  console.error('GROQ_API_KEY is missing');
  process.exit(1);
}

// Initialize APIs
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Initialize PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Add this near the top of your file, after the pool initialization
const initializeDatabase = async () => {
  try {
    // Create tables if they don't exist
    await pool.query(`
      -- Create chat_sessions table if not exists
      CREATE TABLE IF NOT EXISTS chat_sessions (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Create messages table if not exists
      CREATE TABLE IF NOT EXISTS messages (
          id SERIAL PRIMARY KEY,
          session_id INTEGER REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );

      -- Create indexes if they don't exist
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
    `);
    
    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database tables:', error);
    process.exit(1);
  }
};

// Update the database connection test to also initialize tables
pool.query('SELECT NOW()', async (err, res) => {
  if (err) {
    console.error('Database connection error:', err);
    process.exit(1);
  } else {
    console.log('Database connected successfully');
    await initializeDatabase();
  }
});

// Configure multer
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
}).single('image');

app.post('/api/chat-with-image', async (req, res) => {
  console.log('Received image chat request');
  
  try {
    // Handle file upload with better error handling
    await new Promise((resolve, reject) => {
      upload(req, res, (err) => {
        if (err) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            reject(new Error('File size exceeds 5MB limit'));
          } else {
            reject(new Error('File upload failed'));
          }
        }
        resolve();
      });
    });

    // Validate file existence and type
    if (!req.file) {
      throw new Error('No image file uploaded');
    }
    
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(req.file.mimetype)) {
      throw new Error('Invalid file type. Only JPEG, PNG, and WEBP are allowed.');
    }

    // Parse messages with better validation
    let messages;
    try {
      messages = JSON.parse(req.body.messages || '[]');
      if (!Array.isArray(messages)) {
        throw new Error('Messages must be an array');
      }
    } catch (error) {
      throw new Error(`Invalid messages format: ${error.message}`);
    }

    console.log('File details:', {
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size
    });

    // Process with Gemini
    console.log('Processing with Gemini...');
    const geminiModel = genAI.getGenerativeModel({ model: "gemini-pro-vision" });
    
    const imagePart = {
      inlineData: {
        data: req.file.buffer.toString('base64'),
        mimeType: req.file.mimetype
      }
    };

    const geminiPrompt = "Analyze this image in detail and provide a comprehensive description.";
    console.log('Sending request to Gemini...');
    
    const geminiResult = await geminiModel.generateContent([geminiPrompt, imagePart]);
    const geminiAnalysis = await geminiResult.response.text();
    console.log('Gemini analysis received');

    // Set up streaming response
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Process with Groq
    console.log('Processing with Groq...');
    try {
      const completion = await groq.chat.completions.create({
        messages: [
          {
            role: 'system',
            content: 'You are an AI assistant analyzing an image based on the provided description.'
          },
          {
            role: 'user',
            content: `Image analysis: ${geminiAnalysis}\n\nPlease provide insights about this image.`
          }
        ],
        model: 'deepseek-r1-distill-llama-70b',
        temperature: 0.7,
        stream: true,
      });

      console.log('Streaming response...');
      for await (const chunk of completion) {
        if (chunk.choices[0]?.delta?.content) {
          const content = chunk.choices[0].delta.content;
          res.write(`data: ${JSON.stringify({ content })}\n\n`);
        }
      }
    } catch (groqError) {
      throw new Error(`AI processing failed: ${groqError.message}`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
    console.log('Response completed successfully');

  } catch (error) {
    console.error('Error in chat-with-image:', error);
    
    // Standardized error response format
    const errorResponse = {
      error: error.message,
      ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
    };

    if (!res.headersSent) {
      res.status(500).json(errorResponse);
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

// Add new endpoints for chat history
app.post('/api/chat-sessions', async (req, res) => {
  try {
    const { userId, title } = req.body;
    const result = await pool.query(
      'INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING *',
      [userId, title]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating chat session:', error);
    res.status(500).json({ error: 'Failed to create chat session' });
  }
});

app.get('/api/chat-sessions/:userId', cors(corsOptions), async (req, res) => {
  try {
    const { userId } = req.params;
    const result = await pool.query(
      `SELECT 
        id, 
        user_id, 
        title, 
        created_at AT TIME ZONE 'UTC' as created_at 
       FROM chat_sessions 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching chat sessions:', error);
    res.status(500).json({ error: 'Failed to fetch chat sessions' });
  }
});

app.get('/api/messages/:sessionId', cors(corsOptions), async (req, res) => {
  try {
    const { sessionId } = req.params;
    const result = await pool.query(
      `SELECT 
        id, 
        session_id, 
        role, 
        content, 
        created_at AT TIME ZONE 'UTC' as created_at 
       FROM messages 
       WHERE session_id = $1 
       ORDER BY created_at ASC`,
      [sessionId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Update the chat endpoint for better performance
app.post('/api/chat', cors(corsOptions), async (req, res) => {
  console.log('Received chat request');
  
  try {
    const { messages, userId, sessionId } = req.body;
    
    if (!messages || !Array.isArray(messages) || !userId) {
      throw new Error('Invalid request data');
    }

    // Set up SSE headers immediately
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': req.headers.origin || '*'
    });

    let currentSessionId = sessionId;
    let aiResponse = '';

    // Create session and save user message in parallel if needed
    if (!currentSessionId) {
      const sessionPromise = pool.query(
        'INSERT INTO chat_sessions (user_id, title) VALUES ($1, $2) RETURNING id',
        [userId, messages[messages.length - 1].content.substring(0, 50) + '...']
      );

      // Start the Groq API call immediately
      const groqPromise = groq.chat.completions.create({
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        model: "Deepseek-R1-Distill-Llama-70b",
        temperature: 0.6,
        stream: true,
      });

      // Wait for session creation
      const sessionResult = await sessionPromise;
      currentSessionId = sessionResult.rows[0].id;

      // Save user message (don't await)
      pool.query(
        'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
        [currentSessionId, messages[messages.length - 1].role, messages[messages.length - 1].content]
      ).catch(err => console.error('Error saving user message:', err));

      // Get Groq response
      const completion = await groqPromise;
      
      // Stream the response
      for await (const chunk of completion) {
        if (chunk.choices[0]?.delta?.content) {
          const content = chunk.choices[0].delta.content;
          aiResponse += content;
          res.write(`data: ${JSON.stringify({ content, sessionId: currentSessionId })}\n\n`);
        }
      }
    } else {
      // If session exists, just stream the response
      const completion = await groq.chat.completions.create({
        messages: messages.map(msg => ({
          role: msg.role,
          content: msg.content
        })),
        model: "Deepseek-R1-Distill-Llama-70b",
        temperature: 0.6,
        stream: true,
      });

      // Save user message in background
      pool.query(
        'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
        [currentSessionId, messages[messages.length - 1].role, messages[messages.length - 1].content]
      ).catch(err => console.error('Error saving user message:', err));

      for await (const chunk of completion) {
        if (chunk.choices[0]?.delta?.content) {
          const content = chunk.choices[0].delta.content;
          aiResponse += content;
          res.write(`data: ${JSON.stringify({ content, sessionId: currentSessionId })}\n\n`);
        }
      }
    }

    // Save AI response in background
    if (aiResponse) {
      pool.query(
        'INSERT INTO messages (session_id, role, content) VALUES ($1, $2, $3)',
        [currentSessionId, 'assistant', aiResponse]
      ).catch(err => console.error('Error saving AI response:', err));
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (error) {
    console.error('Error in chat endpoint:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.end();
    }
  }
});

// Add this new endpoint to delete a chat session
app.delete('/api/chat-sessions/:sessionId', cors(corsOptions), async (req, res) => {
  console.log('Delete request received for session:', req.params.sessionId);
  
  try {
    const { sessionId } = req.params;
    const userId = req.query.userId;

    if (!sessionId || !userId) {
      return res.status(400).json({ 
        error: 'Missing required parameters' 
      });
    }

    console.log('Deleting session:', { sessionId, userId });

    // Verify the session belongs to the user
    const verifyResult = await pool.query(
      'SELECT user_id FROM chat_sessions WHERE id = $1',
      [sessionId]
    );

    if (verifyResult.rows.length === 0) {
      return res.status(404).json({ error: 'Chat session not found' });
    }

    if (verifyResult.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Delete the session (messages will be deleted automatically due to CASCADE)
    await pool.query('DELETE FROM chat_sessions WHERE id = $1', [sessionId]);

    res.json({ message: 'Chat session deleted successfully' });
  } catch (error) {
    console.error('Error deleting chat session:', error);
    res.status(500).json({ 
      error: 'Failed to delete chat session',
      message: error.message 
    });
  }
});

// Add error logging middleware
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  if (!res.headersSent) {
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Environment:', process.env.NODE_ENV);
  console.log('API Keys status:');
  console.log('- GROQ_API_KEY:', process.env.GROQ_API_KEY ? '✓ Present' : '✗ Missing');
  console.log('- GOOGLE_API_KEY:', process.env.GOOGLE_API_KEY ? '✓ Present' : '✗ Missing');
});

// Global error handler
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error);
});