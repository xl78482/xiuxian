import { createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { presentTelegram, setupTelegram } from './telegram';
import App from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('MiniApp root element is missing.');

void setupTelegram().finally(() => {
  createRoot(root).render(createElement(StrictMode, null, createElement(App)));
  requestAnimationFrame(presentTelegram);
});
