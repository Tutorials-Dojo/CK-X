/**
 * Sailor API — business control plane.
 * Responsibilities: user auth, payments, exam definitions, ExamSession lifecycle, CKX session orchestration.
 * CKX never validates users; Sailor enforces access and creates/revokes CKX sessions.
 */
const express = require('express');
const cors = require('cors');
const config = require('./config');
const authRoutes = require('./routes/auth');
const paymentsRoutes = require('./routes/payments');
const examsRoutes = require('./routes/exams');
const examSessionsRoutes = require('./routes/exam-sessions');
const setupCkxProxyRoutes = require('./routes/ckx-proxy');
const { createIframeToken } = require('./lib/iframe-token');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'sailor-api' });
});

// GET /exam — serve exam interface through CKX proxy with iframeToken auth
// This endpoint is called by clients after creating an exam session.
// It generates an iframeToken and redirects to the exam through the CKX proxy.
app.get('/exam', async (req, res) => {
  const { sessionId: ckxSessionId, examSessionId, examId, mode } = req.query;
  
  if (!ckxSessionId || !examSessionId) {
    return res.status(400).json({ error: 'sessionId and examSessionId query params required' });
  }

  try {
    // Get the exam session to extract userId and verify it exists
    const examSession = await prisma.examSession.findUnique({
      where: { id: examSessionId },
    });

    if (!examSession) {
      return res.status(404).json({ error: 'Exam session not found' });
    }

    // Generate iframeToken for this exam session
    const iframeToken = createIframeToken(ckxSessionId, examSession.userId);

    // Redirect to the exam through the CKX proxy with iframeToken
    // The CKX proxy will validate the token, proxy to CKX, and inject the fetch monkey-patch
    const redirectUrl = `/ckx/sessions/${encodeURIComponent(ckxSessionId)}/vnc-proxy/exam.html?iframeToken=${encodeURIComponent(iframeToken)}`;
    
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('Error in /exam redirect:', err.message);
    res.status(500).json({ error: 'Failed to initialize exam', message: err.message });
  }
});

app.use('/auth', authRoutes);
app.use('/payments', paymentsRoutes);
app.use('/exams', examsRoutes);
app.use('/exam-sessions', examSessionsRoutes);

// CKX proxy routes (VNC/terminal access - validates session access before proxying)
setupCkxProxyRoutes(app);

// Debug route to test parameter parsing (remove in production)
if (config.nodeEnv === 'development') {
  app.get('/debug/ckx/:ckxSessionId/test', (req, res) => {
    res.json({ params: req.params, query: req.query, url: req.url });
  });
}

// Global error handler - ALWAYS returns JSON, never HTML
app.use((err, req, res, next) => {
  console.error('Sailor API error:', err);
  
  // Determine appropriate status code
  const statusCode = err.statusCode || err.status || 500;
  
  // Build error response - always JSON
  const errorResponse = {
    error: err.message || 'Internal server error',
    statusCode,
  };
  
  // Include additional context in development
  if (process.env.NODE_ENV === 'development' && err.stack) {
    errorResponse.stack = err.stack;
  }
  
  // Ensure headers haven't been sent
  if (res.headersSent) {
    return next(err);
  }
  
  res.status(statusCode).json(errorResponse);
});

// Catch-all 404 handler for unmatched routes - ALWAYS returns JSON
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`,
    statusCode: 404,
  });
});

app.listen(config.port, () => {
  console.log(`Sailor API listening on port ${config.port}`);
});
