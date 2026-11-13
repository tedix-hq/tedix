export const SLIDES_CSS = `
:root{font:14px var(--tedix-font,system-ui,sans-serif);color:var(--tedix-fg,CanvasText)}
*{box-sizing:border-box}
html,body{margin:0}
body{padding:0!important;min-height:560px;overflow:hidden}
.slides-app{--bg:var(--tedix-bg,Canvas);--fg:var(--tedix-fg,CanvasText);--surface:var(--tedix-surface,var(--tedix-bg,Canvas));--muted:var(--tedix-muted,color-mix(in srgb,CanvasText 6%,Canvas));--muted-fg:var(--tedix-muted-fg,GrayText);--line:var(--tedix-border,color-mix(in srgb,CanvasText 14%,transparent));--primary:var(--tedix-primary,Highlight);--on-primary:var(--tedix-on-primary,HighlightText);--danger:var(--tedix-danger,#d92d20);--success:var(--tedix-success,#16803c);--ease:cubic-bezier(.2,.8,.2,1);--tint:color-mix(in srgb,var(--fg) 8%,transparent);--tint-strong:color-mix(in srgb,var(--fg) 14%,transparent);position:fixed;inset:0;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);animation:slides-fade .32s var(--ease)}
.slides-app button,.slides-app input,.slides-app select,.slides-app textarea{font:inherit;color:inherit}
.slides-app button{cursor:pointer;border:1px solid var(--line);border-radius:7px;background:var(--bg);padding:6px 10px;transition:background-color .12s var(--ease),border-color .12s var(--ease),opacity .12s var(--ease),transform .12s var(--ease)}
.slides-app button:disabled{opacity:.38;cursor:default}
.slides-app button:active:not(:disabled){transform:scale(.94)}
.slides-app button:focus-visible,.slides-app input:focus-visible,.slides-app select:focus-visible,.slides-app textarea:focus-visible,.slides-app summary:focus-visible{outline:2px solid var(--primary);outline-offset:2px}
.slides-app button.icon,.slides-app button.ghost{border-color:transparent;background:transparent}
.slides-app button.icon{display:inline-grid;place-items:center;min-width:30px;width:30px;height:30px;padding:0;border-radius:7px}
.slides-app button.ghost{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;white-space:nowrap}
.slides-app button.icon:hover:not(:disabled),.slides-app button.ghost:hover:not(:disabled){background:var(--tint)}
.slides-app button.icon:active:not(:disabled),.slides-app button.ghost:active:not(:disabled),.slides-app button.icon[aria-expanded=true],.slides-app button.ghost[aria-expanded=true]{background:var(--tint-strong)}
.slides-app button.primary{background:var(--primary);border-color:transparent;color:var(--on-primary)}
.slides-app button.primary:hover:not(:disabled){background:color-mix(in srgb,var(--primary) 88%,var(--fg))}
.slides-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.slides-bar{position:relative;z-index:5;flex:none;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--line)}
.slides-bar-left{min-width:0}
.slides-bar-left h1{margin:0;font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slides-bar-tools{display:flex;align-items:center;gap:2px}
.slides-bar-right{display:flex;align-items:center;justify-content:flex-end;gap:4px;min-width:0}
.slides-status{min-width:0;margin-right:4px;font-size:12px;line-height:1.35;color:var(--muted-fg);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:opacity .16s var(--ease)}
.slides-status:empty{opacity:0}
.slides-save{flex:none;width:6px;height:6px;margin-right:8px;border-radius:50%;background:var(--success);opacity:.7}
.slides-save[data-state=pending]{background:var(--muted-fg)}
.slides-save[data-state=saving]{background:var(--primary);opacity:1;animation:slides-saving 1.1s ease-in-out infinite}
.slides-save[data-state=failed]{background:var(--danger);opacity:1}
@keyframes slides-saving{50%{opacity:.3;transform:scale(.75)}}
.slides-status[data-error=true]{color:var(--danger);white-space:normal}
.slides-updates{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:8px 12px;font-size:13px;line-height:1.45;background:color-mix(in srgb,var(--primary) 10%,var(--bg));border-bottom:1px solid var(--line);animation:slides-drop .2s var(--ease)}
.slides-updates:empty{display:none}
.slides-menu-anchor{position:relative;display:inline-flex}
.slides-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:20;display:grid;min-width:184px;max-height:min(70vh,440px);overflow-y:auto;padding:4px;background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:0 2px 6px #0000001a,0 12px 32px #00000026;transform-origin:top left;animation:slides-pop .16s var(--ease)}
.slides-menu.end{left:auto;right:0;transform-origin:top right}
.slides-menu[hidden]{display:none}
.slides-app .slides-bar [hidden]{display:none}
.slides-app .slides-menu button{display:block;width:100%;border:0;border-radius:6px;background:transparent;padding:6px 10px;text-align:left;white-space:nowrap}
.slides-app .slides-menu button:hover:not(:disabled),.slides-app .slides-menu button:focus-visible{background:var(--tint);outline:none}
.slides-app .slides-menu button:active:not(:disabled){transform:none;background:var(--tint-strong)}
.slides-menu hr{width:100%;height:1px;margin:4px 0;border:0;background:var(--line)}
.slides-layout{position:relative;flex:1;min-height:0;display:flex}
.slides-rail{flex:none;width:168px;overflow-y:auto;padding:10px 8px 10px 4px;border-right:1px solid var(--line)}
.slides-rail nav{display:grid;gap:10px}
.slides-thumb{position:relative;display:grid;grid-template-columns:20px minmax(0,1fr);align-items:start;gap:4px}
.slides-thumb-number{padding-top:3px;font-size:11px;text-align:right;color:var(--muted-fg);font-variant-numeric:tabular-nums}
.slides-thumb.current .slides-thumb-number{color:var(--fg);font-weight:600}
.slides-app .slides-thumbnail{display:block;width:100%;padding:0;overflow:hidden;border:1px solid var(--line);border-radius:6px;background:#fff;transition:box-shadow .12s var(--ease),border-color .12s var(--ease)}
.slides-app .slides-thumbnail:active:not(:disabled){transform:none}
.slides-thumb:hover .slides-thumbnail{border-color:color-mix(in srgb,var(--fg) 34%,transparent)}
.slides-thumb.current .slides-thumbnail{border-color:var(--primary);box-shadow:0 0 0 2px var(--primary)}
.slides-thumb-actions{position:absolute;top:4px;right:4px;display:flex;gap:2px;opacity:0;transition:opacity .12s var(--ease)}
.slides-thumb:hover .slides-thumb-actions,.slides-thumb:focus-within .slides-thumb-actions{opacity:1}
.slides-app .slides-thumb-actions button{display:grid;place-items:center;width:22px;height:22px;padding:0;border-radius:6px;color:var(--fg);background:var(--surface);box-shadow:0 1px 3px #0000002e}
.slides-thumb-actions svg{width:12px;height:12px}
.slides-thumb[data-drop]::before{content:"";position:absolute;left:24px;right:0;height:2px;border-radius:2px;background:var(--primary)}
.slides-thumb[data-drop=before]::before{top:-6px}
.slides-thumb[data-drop=after]::before{bottom:-6px}
.slides-thumb.entering{animation:slides-thumb-in .24s var(--ease)}
.slides-skeleton{margin-left:24px;aspect-ratio:16/9;border-radius:6px}
.slides-skeleton,.slides-app[data-loading] .slides-stage{background:linear-gradient(90deg,var(--tint),var(--tint-strong),var(--tint)) 0 0/200% 100%!important;box-shadow:none;animation:slides-shimmer 1.3s linear infinite}
.slides-thumb-canvas,.slides-stage,.slides-present-stage{position:relative;width:100%;aspect-ratio:16/9;container-type:inline-size;isolation:isolate;color:#111;background:#fff}
.slides-thumb-canvas,.slides-present-stage{overflow:hidden}
.slides-thumb-canvas{pointer-events:none}
.slides-workspace{flex:1;min-width:0;display:flex;flex-direction:column;background:var(--muted)}
.slides-canvas{flex:1;min-height:0;display:grid;place-items:center;padding:24px;overflow:hidden}
.slides-stage{border-radius:10px;box-shadow:0 0 0 1px #0000000d,0 1px 2px #0000000f,0 6px 16px #00000014,0 22px 48px #0000001a;touch-action:none;outline:none}
.slides-stage:focus-visible{outline:2px solid var(--primary);outline-offset:3px}
.slides-background{position:absolute;inset:0;overflow:hidden;border-radius:inherit;pointer-events:none}
.slides-element{position:absolute;white-space:pre-wrap;overflow-wrap:break-word;overflow:hidden;touch-action:none;user-select:none}
.slides-app img[data-linked-state="failed"]{background:color-mix(in srgb,currentColor 12%,transparent)}
.slides-stage .slides-element{cursor:move}
.slides-stage .slides-element:not(.selected):hover{outline:1px dashed var(--tedix-primary,#3669e8);outline-offset:1px}
.slides-stage .slides-element.selected{outline:1.5px solid var(--tedix-primary,#3669e8);outline-offset:1px;overflow:visible}
.slides-stage .slides-element.selected>img{overflow:hidden}
.slides-stage .slides-element:focus-visible{outline:2px solid var(--tedix-primary,#3669e8);outline-offset:2px}
.slides-stage.switching>.slides-element,.slides-stage.switching>.slides-background{animation:slides-swap .22s var(--ease)}
@keyframes slides-land{0%,30%{box-shadow:0 0 0 3px var(--primary),0 0 0 7px color-mix(in srgb,var(--primary) 28%,transparent)}to{box-shadow:0 0 0 3px transparent,0 0 0 7px transparent}}
.slides-stage .slides-element.landed,.slides-thumb.landed .slides-thumbnail{animation:slides-land 2.4s var(--ease) both}
@media(prefers-reduced-motion:reduce){.slides-stage .slides-element.landed,.slides-thumb.landed .slides-thumbnail{animation:none;box-shadow:0 0 0 3px color-mix(in srgb,var(--primary) 60%,transparent)}}
.slides-stage .slides-element.fresh{animation:slides-rise .26s var(--ease)}
.slides-app .slides-resize{position:absolute;z-index:2;width:10px;height:10px;padding:0;border:1.5px solid var(--tedix-primary,#3669e8);border-radius:3px;background:#fff;translate:-50% -50%;transform:none;transition:none;touch-action:none}
.slides-resize[data-handle=nw]{left:0;top:0;cursor:nwse-resize}
.slides-resize[data-handle=n]{left:50%;top:0;cursor:ns-resize}
.slides-resize[data-handle=ne]{left:100%;top:0;cursor:nesw-resize}
.slides-resize[data-handle=e]{left:100%;top:50%;cursor:ew-resize}
.slides-resize[data-handle=se]{left:100%;top:100%;cursor:nwse-resize}
.slides-resize[data-handle=s]{left:50%;top:100%;cursor:ns-resize}
.slides-resize[data-handle=sw]{left:0;top:100%;cursor:nesw-resize}
.slides-resize[data-handle=w]{left:0;top:50%;cursor:ew-resize}
.slides-guides{position:absolute;inset:0;z-index:3;pointer-events:none}
.slides-guide{position:absolute;background:var(--tedix-primary,#3669e8)}
.slides-guide.v{top:0;bottom:0;width:1px}
.slides-guide.h{left:0;right:0;height:1px}
.slides-inline-editor{display:block;width:100%;height:100%;resize:none;border:0!important;border-radius:0;padding:0!important;margin:0;background:transparent;color:inherit!important;font:inherit!important;text-align:inherit;line-height:inherit;letter-spacing:inherit;outline:none!important;user-select:text;cursor:text}
.slides-empty{position:absolute;inset:0;display:grid;place-items:center;color:#666;font-size:16px}
.slides-notes{flex:none;display:block;padding:0 24px 14px}
.slides-notes textarea{display:block;width:100%;height:58px;resize:none;padding:8px 10px;border:1px solid transparent;border-radius:8px;background:color-mix(in srgb,var(--bg) 72%,transparent);font-size:13px;line-height:1.45;transition:background-color .12s var(--ease),border-color .12s var(--ease)}
.slides-notes textarea:hover:not(:disabled),.slides-notes textarea:focus{background:var(--bg);border-color:var(--line)}
.slides-notes textarea::placeholder{color:var(--muted-fg)}
.slides-inspector{flex:none;width:0;overflow:hidden;visibility:hidden;background:var(--bg);border-left:0 solid var(--line);transition:width .22s var(--ease),visibility 0s .22s}
.slides-inspector[data-open=true]{width:264px;border-left-width:1px;visibility:visible;transition:width .22s var(--ease),visibility 0s}
.slides-inspector-body{width:263px;height:100%;overflow-y:auto;padding:12px}
.slides-inspector h2{margin:2px 0 12px;font-size:13px;font-weight:600}
.slides-inspector label{display:grid;gap:4px;margin-bottom:10px;font-size:12px;color:var(--muted-fg)}
.slides-inspector input,.slides-inspector select,.slides-inspector textarea{width:100%;min-width:0;padding:5px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.slides-inspector textarea{min-height:68px;resize:vertical}
.slides-fields{display:grid;grid-template-columns:1fr 1fr;column-gap:8px}
.slides-fields>.wide{grid-column:1/-1}
.slides-inspector label.slides-color{grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:6px}
.slides-swatch{position:relative;width:28px;height:28px;overflow:hidden;border:1px solid var(--line);border-radius:7px;background:repeating-conic-gradient(#d9d9d9 0 25%,#fff 0 50%) 0 0/10px 10px}
.slides-swatch:focus-within{outline:2px solid var(--primary);outline-offset:2px}
.slides-swatch i{position:absolute;inset:0}
.slides-inspector .slides-swatch input{position:absolute;inset:-6px;width:calc(100% + 12px);height:calc(100% + 12px);padding:0;border:0;opacity:0;cursor:pointer}
.slides-app .slides-color button{padding:3px 8px;font-size:12px;border-color:transparent;background:transparent;color:var(--muted-fg)}
.slides-app .slides-color button:hover:not(:disabled){background:var(--tint);color:var(--fg)}
.slides-advanced{margin:4px 0 10px;border-top:1px solid var(--line)}
.slides-advanced summary{padding:10px 0;font-size:12px;font-weight:600;cursor:pointer;border-radius:4px}
#layers{display:grid;gap:2px;margin-bottom:8px}
.slides-app #layers button{border-color:transparent;background:transparent;padding:5px 8px;font-size:12px;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.slides-app #layers button:hover{background:var(--tint)}
.slides-app #layers button:active{transform:none}
.slides-app #layers button[aria-pressed=true]{background:color-mix(in srgb,var(--primary) 14%,transparent)}
#presenter{position:fixed;inset:0;z-index:100;display:grid;place-items:center;background:#000;color:#fff;outline:none;animation:slides-fade .2s var(--ease)}
#presenter[hidden]{display:none}
#presenter.idle{cursor:none}
.slides-present-stage{width:min(100vw,calc(100vh*16/9))}
.slides-present-stage.switching>*{animation:slides-swap .22s var(--ease)}
.slides-present-controls{position:absolute;left:50%;bottom:16px;translate:-50% 0;display:flex;align-items:center;gap:2px;padding:4px;border:1px solid #ffffff24;border-radius:12px;background:#1c1c1fe6;transition:opacity .2s var(--ease)}
#presenter.idle .slides-present-controls:not(:has(:focus-visible)){opacity:0;pointer-events:none}
.slides-app .slides-present-controls button{color:#fff}
.slides-app .slides-present-controls button:hover:not(:disabled){background:#ffffff24}
.slides-present-pill{position:absolute;top:16px;right:16px;padding:4px 10px;border-radius:999px;background:#1c1c1fe6;font-size:12px;font-variant-numeric:tabular-nums;opacity:0;transition:opacity .2s var(--ease);pointer-events:none}
.slides-present-pill.show{opacity:1}
@keyframes slides-fade{from{opacity:0}}
@keyframes slides-pop{from{opacity:0;transform:scale(.96)}}
@keyframes slides-drop{from{opacity:0;translate:0 -6px}}
@keyframes slides-swap{from{opacity:0;translate:0 8px}}
@keyframes slides-rise{from{opacity:0;translate:0 6px}}
@keyframes slides-thumb-in{from{opacity:0;transform:scale(.92)}}
@keyframes slides-shimmer{to{background-position:-200% 0}}
@media(max-width:900px){.slides-bar{display:flex;flex-wrap:wrap}.slides-bar-left{flex:1 1 120px}.slides-bar-tools{flex-wrap:wrap}.slides-bar-right{flex:1 1 auto}.slides-rail{width:128px}.slides-inspector{position:absolute;top:0;right:0;bottom:0;z-index:4;box-shadow:-8px 0 24px #00000026}.slides-canvas{padding:16px}.slides-notes{padding:0 16px 12px}}
@media(max-width:600px){.slides-bar-left{flex-basis:100%}.slides-rail{width:88px;padding:8px 6px}.slides-thumb{grid-template-columns:minmax(0,1fr)}.slides-thumb-number{display:none}.slides-thumb[data-drop]::before{left:0}.slides-skeleton{margin-left:0}.slides-canvas{padding:10px}.slides-notes{padding:0 10px 10px}}
@media(pointer:coarse){.slides-app button.icon{min-width:44px;width:44px;height:44px}.slides-app button.ghost{height:44px}.slides-app .slides-menu button{min-height:44px}.slides-thumb-actions{position:static;grid-column:1/-1;justify-content:flex-end;opacity:1}.slides-thumb:not(.current) .slides-thumb-actions{display:none}.slides-app .slides-thumb-actions button{width:44px;height:44px;box-shadow:none}.slides-app .slides-resize{width:18px;height:18px}.slides-swatch{width:44px;height:44px}}
@media(prefers-reduced-motion:reduce){.slides-app,.slides-app *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}}
`;
