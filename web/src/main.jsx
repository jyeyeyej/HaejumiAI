import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.jsx';
import './style.css';
import './theme.css';

createRoot(document.getElementById('root')).render(<App />);
