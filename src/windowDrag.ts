import type {MouseEvent} from 'react';
import {getCurrentWebviewWindow} from '@tauri-apps/api/webviewWindow';
import './window-drag.css';

// Titles, nested icons and blank header areas share the same native drag action.
export function dragWindow(event:MouseEvent<HTMLElement>){
 if(event.button!==0||event.defaultPrevented||(event.target as Element).closest(
  'button,[role=button],[role=tab],input,select,textarea,a,summary,[contenteditable],[data-no-window-drag]'))return;
 event.preventDefault();
 void getCurrentWebviewWindow().startDragging().catch(cause=>console.error('窗口拖动失败',cause));
}
