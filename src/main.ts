import './style.css';
import { Game } from './game/game';

const canvas = document.getElementById('game-canvas');
const minimap = document.getElementById('minimap');

if (!(canvas instanceof HTMLCanvasElement) || !(minimap instanceof HTMLCanvasElement)) {
  throw new Error('LINE could not initialize its canvases.');
}

const game = new Game(canvas, minimap);
game.start();
