import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/noto-sans-ethiopic/400.css';
import '@fontsource/noto-sans-ethiopic/600.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import './wallet-staff.css';

const root = document.getElementById('root');
if (!root) throw new Error('App root is missing');
createRoot(root).render(<React.StrictMode><App /></React.StrictMode>);
