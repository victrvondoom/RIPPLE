import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './theme.css'; // Flip-the-Switch peach theme (override layer; loaded last)
createRoot(document.getElementById('root')!).render(<App />);
