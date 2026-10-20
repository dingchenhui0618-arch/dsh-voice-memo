// Build and packaging tests. `dsh plugin add github:…` consumes the committed
// lib/ output, so a build that produces a broken bundle must fail here first.

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')

test('the build script produces a loadable host entry and a self-contained client bundle', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'build.mjs')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.equal(result.status, 0, 'build failed:\n' + (result.stderr || '') + (result.stdout || ''))

  for (const file of ['index.js', 'client.js', 'pcm.cjs', 'png.js', 'notes.js', 'store.js', 'transcribe.js']) {
    assert.ok(existsSync(join(lib, file)), 'lib/' + file + ' exists')
  }

  const bundle = readFileSync(join(lib, 'client.js'), 'utf8')
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/)
  assert.match(bundle, /id: "dsh-voice-memo"/)
  assert.match(bundle, /inlined src\/pcm\.cjs/)
  assert.doesNotMatch(bundle, /require\(['"]\.\//, 'no relative require survives inlining')
  assert.match(bundle, /function encodeWav/)
  assert.match(bundle, /\.vm-root\{/)

  // A syntax error would surface as a browser load failure; catch it here.
  new Function(bundle)
})

test('the built host module exports the plugin contract', async () => {
  const module = await import(pathToFileURL(join(lib, 'index.js')).href + '?built=' + Date.now())
  assert.equal(module.name, 'dsh-voice-memo')
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['webServer'])
})

test('package.json declares what the bundle loader and the market require', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-voice-memo')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'lib/index.js')
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'the declared patch file exists')
  assert.ok(Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.length >= 1)
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.keywords.includes('dsh-plugin'), 'the market topic keyword is present')
  assert.ok(pkg.files.includes('lib') && pkg.files.includes('cordis.patch.yml'))
  assert.ok(pkg.files.includes('workers/*.py'), 'the optional local worker ships with the package')

  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /- insert:/)
  assert.match(patch, /id: dsh-voice-memo/)
  assert.match(patch, /name: dsh-voice-memo/)
})

test('the repository carries the files a public project needs', () => {
  for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE', '.gitignore', '.gitattributes', 'icon.svg',
    'locale/zh.json', 'locale/en.json', 'workers/transcribe_faster_whisper.py']) {
    assert.ok(existsSync(join(root, file)), file + ' is present')
  }
  const license = readFileSync(join(root, 'LICENSE'), 'utf8')
  assert.match(license, /MIT License/)
  for (const locale of ['locale/zh.json', 'locale/en.json']) {
    const parsed = JSON.parse(readFileSync(join(root, locale), 'utf8'))
    assert.ok(parsed.meta.title.length > 0, locale + ' has a title')
    assert.ok(parsed.meta.description.length > 0, locale + ' has a description')
  }
})
