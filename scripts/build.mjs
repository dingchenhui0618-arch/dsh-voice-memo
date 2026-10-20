#!/usr/bin/env node
// Dependency-free build.
//
// The host half is plain ESM whose only imports are node: builtins and sibling
// modules, so copying the sources into lib/ is a complete build — no bundler,
// therefore no devDependency that can fail to install.
//
// The client half is CommonJS loaded through window.__ModuleLoader__ with a
// harness-provided require(), so it may not carry a relative require of its own.
// It needs two: the stylesheet and the shared PCM helpers. Both are inlined
// below, and the build fails loudly if either require disappears or changes
// shape. Inlining pcm.cjs is what lets the browser encode the same canonical
// 16 kHz mono WAV the Host stores, without a second copy of the code.
//
// If this plugin is ever published with a bundler, the output layout stays the
// same: lib/index.js (host entry), lib/client.js (browser bundle), lib/*.js.

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { wrapClient } from './wrap-client.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'lib')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// host.js becomes index.js; its sibling imports keep their names.
await copyFile(join(root, 'src', 'host.js'), join(out, 'index.js'))
for (const file of ['store.js', 'transcribe.js', 'png.js', 'notes.js', 'pcm.cjs']) {
  await copyFile(join(root, 'src', file), join(out, file))
}

const cssModule = await import(pathToFileURL(join(root, 'src', 'client-css.cjs')).href)
const css = cssModule.default
if (typeof css !== 'string' || css.length === 0) {
  throw new Error('src/client-css.cjs did not export a non-empty CSS string')
}

const clientSource = await readFile(join(root, 'src', 'client.cjs'), 'utf8')
const CSS_REQUIRE = /require\((['"])\.\/client-css\.cjs\1\)/
const PCM_REQUIRE = /require\((['"])\.\/pcm\.cjs\1\)/
if (!CSS_REQUIRE.test(clientSource)) {
  throw new Error('src/client.cjs no longer requires ./client-css.cjs — update scripts/build.mjs')
}
if (!PCM_REQUIRE.test(clientSource)) {
  throw new Error('src/client.cjs no longer requires ./pcm.cjs — update scripts/build.mjs')
}

const pcmSource = await readFile(join(root, 'src', 'pcm.cjs'), 'utf8')
const pcmInline = [
  '// --- inlined src/pcm.cjs (shared with the host half) ---',
  'var __pcmBundle = (function () {',
  '  var module = { exports: {} };',
  '  var exports = module.exports;',
  pcmSource.replace(/\s+$/, ''),
  '  return module.exports;',
  '})();',
  '// --- end inlined pcm ---',
].join('\n')

const inlined = clientSource.replace(CSS_REQUIRE, JSON.stringify(css)).replace(PCM_REQUIRE, '__pcmBundle')
if (/require\((['"])\.\//.test(inlined)) {
  throw new Error('src/client.cjs still has a relative require after inlining — the browser bundle would load with a broken dependency')
}

const bundle = wrapClient(pcmInline + '\n' + inlined, pkg.name)
await writeFile(join(out, 'client.js'), bundle)

// Compile the client bundle and import the host module: a broken build fails
// here rather than in the browser, where the error is much harder to read.
new Function(bundle)
const host = await import(pathToFileURL(join(out, 'index.js')).href)
if (host.name !== pkg.name || typeof host.apply !== 'function') {
  throw new Error('invalid host plugin export: expected name "' + pkg.name + '" and an apply() function')
}

console.log('Built ' + pkg.name + ' ' + pkg.version + ': lib/index.js (' +
  (await readFile(join(out, 'index.js'), 'utf8')).length + ' bytes) and lib/client.js (' + bundle.length + ' bytes)')
