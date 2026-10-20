// Client styles for dsh-voice-memo.
//
// Same rule as the rest of this family of panels: colour comes from
// currentColor mixed against transparent, plus the harness status/brand tokens.
// There is no hard-coded page background or text colour, so the panel stays
// legible in both the light and the dark theme without shipping two palettes.
// The waveform image itself is transparent with its own accent colours, which is
// why it reads on both backgrounds too.

module.exports = [
  '.vm-root{display:flex;flex-direction:column;gap:14px;padding:18px 18px 112px;height:auto;min-height:100%;box-sizing:border-box;color:inherit;font-size:13px;line-height:1.55}',
  '.vm-head{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap}',
  '.vm-title{font-size:16px;font-weight:600;letter-spacing:.01em}',
  '.vm-sub{opacity:.55;font-size:12px;margin-top:2px}',
  '.vm-spacer{flex:1}',

  '.vm-chip{display:inline-flex;align-items:center;font-size:10.5px;line-height:1.6;padding:0 8px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);white-space:nowrap}',
  '.vm-chip.vm-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent)}',
  '.vm-chip.vm-warn{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 9%,transparent)}',
  '.vm-chip.vm-bad{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent)}',

  '.vm-stage{display:flex;flex-direction:column;align-items:center;gap:10px;padding:18px 18px 14px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:14px;background:color-mix(in srgb,currentColor 3%,transparent)}',
  '.vm-record{display:inline-flex;align-items:center;gap:10px;min-width:196px;justify-content:center;padding:13px 24px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 46%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);color:inherit;font:inherit;font-size:13.5px;font-weight:600;cursor:pointer;touch-action:none;user-select:none;transition:background .15s ease,border-color .15s ease}',
  '.vm-record:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent)}',
  '.vm-record:disabled{opacity:.5;cursor:default}',
  '.vm-record-on{border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);animation:vm-pulse 1.4s ease-in-out infinite}',
  '.vm-record-dot{width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-error-primary);flex:none}',
  '.vm-record-on .vm-record-dot{border-radius:2px}',
  '.vm-record-text{font-variant-numeric:tabular-nums}',
  '@keyframes vm-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-error-primary) 34%,transparent)}55%{box-shadow:0 0 0 9px transparent}}',

  '.vm-meter{display:flex;align-items:center;gap:3px;height:22px}',
  '.vm-meter i{display:block;width:3px;height:20px;border-radius:2px;background:color-mix(in srgb,currentColor 26%,transparent);transform-origin:center;transition:transform .07s linear}',
  '.vm-meter i.vm-meter-on{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,transparent)}',
  '.vm-stage-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;font-size:11.5px;opacity:.68}',
  '.vm-live{color:var(--dsw-alias-state-error-primary);opacity:1;font-variant-numeric:tabular-nums;font-weight:600}',
  '.vm-path{font-size:11.5px;opacity:.5;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',

  '.vm-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(92px,1fr));gap:8px}',
  '.vm-stat{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:9px;padding:8px 11px}',
  '.vm-stat b{display:block;font-size:18px;line-height:1.2;font-variant-numeric:tabular-nums}',
  '.vm-stat span{font-size:11px;opacity:.55}',

  '.vm-empty{border:1px dashed color-mix(in srgb,currentColor 20%,transparent);border-radius:12px;padding:24px 18px;text-align:center;font-size:12.5px;opacity:.6;max-width:640px;margin:0 auto}',
  '.vm-list{display:flex;flex-direction:column;gap:12px}',
  '.vm-card{border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:9px;background:color-mix(in srgb,currentColor 2%,transparent);transition:border-color .15s ease}',
  '.vm-card-active{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 44%,transparent)}',
  '.vm-card-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
  '.vm-card-title{font-size:13.5px;font-weight:600;max-width:100%;overflow-wrap:anywhere}',
  '.vm-card-meta{font-size:11.5px;opacity:.55;font-variant-numeric:tabular-nums}',

  '.vm-wave{position:relative;border-radius:8px;overflow:hidden;background:color-mix(in srgb,currentColor 4%,transparent)}',
  '.vm-wave-img{display:block;width:100%;height:auto}',
  '.vm-wave-hit{position:absolute;inset:0;width:100%;border:0;padding:0;background:transparent;cursor:pointer}',
  '.vm-wave-progress{position:absolute;top:0;bottom:0;width:2px;background:var(--dsw-alias-brand-primary);box-shadow:0 0 6px color-mix(in srgb,var(--dsw-alias-brand-primary) 70%,transparent);pointer-events:none}',

  '.vm-card-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
  '.vm-play{border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:transparent;color:inherit;font:inherit;font-size:12px;padding:3px 12px;border-radius:6px;cursor:pointer;min-width:52px}',
  '.vm-play:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
  '.vm-time{font-size:11.5px;opacity:.6;font-variant-numeric:tabular-nums;min-width:96px}',
  '.vm-btn{border:1px solid color-mix(in srgb,currentColor 18%,transparent);background:transparent;color:inherit;font:inherit;font-size:11.5px;padding:3px 9px;border-radius:6px;cursor:pointer}',
  '.vm-btn:hover:not(:disabled){background:color-mix(in srgb,currentColor 8%,transparent)}',
  '.vm-btn:disabled{opacity:.4;cursor:default}',

  '.vm-reason{font-size:11.5px;color:var(--dsw-alias-state-warn-primary)}',
  '.vm-segs{display:flex;flex-direction:column;gap:2px;border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);padding-top:8px}',
  '.vm-seg{display:grid;grid-template-columns:92px 1fr auto;gap:8px;align-items:start;padding:3px 0}',
  '.vm-seg-time{border:0;background:transparent;color:inherit;font:inherit;font-size:11px;opacity:.65;font-variant-numeric:tabular-nums;text-align:left;padding:0;cursor:pointer;text-decoration:underline dotted transparent;text-underline-offset:3px}',
  '.vm-seg-time:hover{opacity:1;text-decoration-color:currentColor}',
  '.vm-seg-text{font-size:12.5px;overflow-wrap:anywhere}',
  '.vm-copy{border:0;background:transparent;color:inherit;font:inherit;font-size:10.5px;opacity:.4;cursor:pointer;padding:1px 2px}',
  '.vm-copy:hover{opacity:.9;text-decoration:underline}',

  '.vm-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary);border-radius:8px;padding:7px 10px;font-size:12px}',
  '.vm-notice{border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 36%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent);border-radius:8px;padding:7px 10px;font-size:12px}',
  '.vm-root audio{display:none}',

  '@media (prefers-reduced-motion:reduce){.vm-record-on{animation:none}.vm-meter i{transition:none}}',
  '@media (max-width:520px){.vm-seg{grid-template-columns:76px 1fr auto}.vm-time{min-width:0}.vm-record{min-width:160px}}',
].join('\n')
