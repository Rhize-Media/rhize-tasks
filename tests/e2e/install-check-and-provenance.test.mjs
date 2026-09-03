// Coverage for two additions made when this repository was split out of the rhize-plugins
// marketplace monorepo (2026-09-03): the installer's non-mutating `--check` mode, and the
// `sourceRef`/`sourceCommit`/`sourceDrift` provenance fields recorded in `installation.json`
// and surfaced by `doctor`. Every system-tool invocation (`sw_vers`, `swift`, `xcodebuild`,
// `git`) is faked here, matching the rest of this suite's no-live-subprocess-I/O policy;
// `checkInstall` is exercised directly against a temporary HOME rather than by spawning the
// real CLI, so the "no writes" assertion is a real filesystem check, not a claim about a
// subprocess we can't inspect.

import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {checkInstall, checkSwiftToolchain, detectSourceProvenance, probePortReadiness} from '../../installer/install.mjs';
import {exactInstallPaths} from '../../installer/safe-paths.mjs';
import {createServiceContext} from '../../service/src/api/context.mjs';

function readyRun({sqliteOk = true, swVersion = '14.5', swiftOk = true, xcodebuildOk = true} = {}) {
  return async (file, args = []) => {
    if (args.some(argument => typeof argument === 'string' && argument.includes('node:sqlite'))) return sqliteOk ? {code: 0, stdout: 'ok', timedOut: false} : {code: 1, stdout: '', stderr: 'ERR_UNKNOWN_BUILTIN_MODULE', timedOut: false};
    if (file === '/usr/bin/sw_vers') return {code: 0, stdout: swVersion, timedOut: false};
    if (file === '/usr/bin/swift') return swiftOk ? {code: 0, stdout: 'swift-driver version: 6.0\nTarget: arm64-apple-macosx14.0\n', timedOut: false} : {code: 1, stdout: '', timedOut: false};
    if (file === '/usr/bin/xcodebuild') return xcodebuildOk ? {code: 0, stdout: 'Xcode 16.0\nBuild version 16A242d\n', timedOut: false} : {code: 1, stdout: '', stderr: "xcode-select: error: tool 'xcodebuild' requires Xcode", timedOut: false};
    throw new Error(`unexpected run: ${file} ${args.join(' ')}`);
  };
}

function freePortServer() {
  return {unref() {}, once() {}, listen(_options, callback) { callback(); }, close(callback) { callback(); }};
}

async function tempHome(label) {
  return mkdtemp(path.join(tmpdir(), `rt-check-${label.slice(0, 10)}-`));
}

test('--check reports ready and writes nothing under Application Support when every signal passes', async () => {
  const home = await tempHome('ready');
  try {
    const paths = exactInstallPaths(home);
    const report = await checkInstall({
      paths, port: 43179, run: readyRun(), platform: 'darwin', nodeVersion: '22.4.0',
      accessImpl: async () => {}, sourceRoot: home, createServerImpl: freePortServer,
    });
    assert.equal(report.ready, true);
    assert.equal(report.blockingReason, null);
    assert.equal(report.checks.platform.nodeMajor, 22);
    assert.equal(report.checks.swiftToolchain.swiftAvailable, true);
    assert.equal(report.checks.codesignAvailable, true);
    assert.equal(report.checks.existingInstallation, null);
    assert.equal(report.plan.installPaths, paths);
    // Nothing was created under HOME at all — not `Library`, not the support dir, not runtime/.
    assert.deepEqual(await readdir(home), []);
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test('--check surfaces the first blocking reason without writing anything (platform failure)', async () => {
  const home = await tempHome('platform');
  try {
    const paths = exactInstallPaths(home);
    const report = await checkInstall({paths, run: readyRun(), platform: 'linux', nodeVersion: '22.4.0', accessImpl: async () => {}, sourceRoot: home, createServerImpl: freePortServer});
    assert.equal(report.ready, false);
    assert.equal(report.blockingReason, 'macos_required');
    assert.deepEqual(await readdir(home), []);
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test('--check surfaces swift_toolchain_unavailable when swift cannot run, independent of the file being executable', async () => {
  const home = await tempHome('swift');
  try {
    const paths = exactInstallPaths(home);
    const report = await checkInstall({paths, run: readyRun({swiftOk: false}), platform: 'darwin', nodeVersion: '22.4.0', accessImpl: async () => {}, sourceRoot: home, createServerImpl: freePortServer});
    assert.equal(report.ready, false);
    assert.equal(report.blockingReason, 'swift_toolchain_unavailable');
    // The platform probe itself still passed (swift was executable, just failed to run) —
    // proves this is a distinct signal from the bucketed 'required_macos_tool_missing'.
    assert.equal(report.checks.platform.error, undefined);
    assert.deepEqual(await readdir(home), []);
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test('--check surfaces a blocked port without ever stopping whatever holds it', async () => {
  const home = await tempHome('port');
  let stopAttempted = false;
  const busyServer = () => ({
    unref() {},
    once(event, handler) { this.handler = handler; },
    listen() { const error = new Error('busy'); error.code = 'EADDRINUSE'; this.handler(error); },
  });
  try {
    const paths = exactInstallPaths(home);
    const probeOwnServer = async () => { stopAttempted = true; return null; };
    const directPortResult = await probePortReadiness(43179, {createServerImpl: busyServer, probeOwnServer});
    assert.equal(directPortResult.status, 'blocked');
    assert.equal(directPortResult.reason, 'loopback_port_in_use');
    // probeOwnServer was consulted (to see whether the holder is our own serve process) but
    // --check must never act on the answer by stopping anything — there is no stop call to
    // make here, and this asserts probePortReadiness's own contract directly.
    assert.equal(stopAttempted, true);
    const report = await checkInstall({
      paths, port: 43179, run: readyRun(), platform: 'darwin', nodeVersion: '22.4.0', accessImpl: async () => {}, sourceRoot: home,
      createServerImpl: busyServer, probeOwnServer,
    });
    assert.equal(report.ready, false);
    assert.equal(report.blockingReason, 'loopback_port_in_use');
    assert.deepEqual(await readdir(home), []);
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test('--check reports an existing installation summary without mutating it', async () => {
  const home = await tempHome('existing');
  try {
    const paths = exactInstallPaths(home);
    await mkdir(paths.supportDir, {recursive: true});
    const manifest = {schemaVersion: 1, version: '0.4.4', sourceRef: 'v0.4.4', sourceCommit: 'a'.repeat(40), runtimePath: path.join(paths.runtimeDir, 'versions', '0.4.4'), signingIdentity: 'ad-hoc'};
    await writeFile(paths.installationManifestPath, `${JSON.stringify(manifest)}\n`);
    const report = await checkInstall({paths, run: readyRun(), platform: 'darwin', nodeVersion: '22.4.0', accessImpl: async () => {}, sourceRoot: home, createServerImpl: freePortServer});
    assert.deepEqual(report.checks.existingInstallation, {version: '0.4.4', sourceRef: 'v0.4.4', sourceCommit: 'a'.repeat(40), runtimePath: manifest.runtimePath, signingIdentity: 'ad-hoc'});
    // The manifest we seeded is untouched — checkInstall only ever reads it.
    assert.deepEqual(JSON.parse(await readFile(paths.installationManifestPath, 'utf8')), manifest);
  } finally {
    await rm(home, {recursive: true, force: true});
  }
});

test('detectSourceProvenance reports the tag when the checkout is exactly on one', async () => {
  const run = async (file, args) => {
    assert.equal(file, 'git');
    if (args.includes('rev-parse') && args.includes('HEAD') && !args.includes('--abbrev-ref')) return {code: 0, stdout: `${'b'.repeat(40)}\n`, timedOut: false};
    if (args.includes('describe')) return {code: 0, stdout: 'v0.5.0\n', timedOut: false};
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
  const result = await detectSourceProvenance({sourceRoot: '/source', run});
  assert.deepEqual(result, {sourceRef: 'v0.5.0', sourceCommit: 'b'.repeat(40)});
});

test('detectSourceProvenance falls back to the branch name when not exactly on a tag', async () => {
  const run = async (file, args) => {
    if (args.includes('rev-parse') && args.includes('HEAD') && !args.includes('--abbrev-ref')) return {code: 0, stdout: `${'c'.repeat(40)}\n`, timedOut: false};
    if (args.includes('describe')) return {code: 128, stdout: '', stderr: 'fatal: no tag exactly matches', timedOut: false};
    if (args.includes('--abbrev-ref')) return {code: 0, stdout: 'main\n', timedOut: false};
    throw new Error(`unexpected git args: ${args.join(' ')}`);
  };
  const result = await detectSourceProvenance({sourceRoot: '/source', run});
  assert.deepEqual(result, {sourceRef: 'main', sourceCommit: 'c'.repeat(40)});
});

test('detectSourceProvenance reports nulls when the source is not a git checkout', async () => {
  const run = async () => { throw new Error('spawn git ENOENT'); };
  const result = await detectSourceProvenance({sourceRoot: '/source', run});
  assert.deepEqual(result, {sourceRef: null, sourceCommit: null});
});

test('checkSwiftToolchain distinguishes a CLT-only toolchain from a full Xcode install without blocking on it', async () => {
  const cltOnly = await checkSwiftToolchain({run: readyRun({xcodebuildOk: false})});
  assert.equal(cltOnly.swiftAvailable, true);
  assert.equal(cltOnly.xcodeFullToolchain, false);
  const fullXcode = await checkSwiftToolchain({run: readyRun()});
  assert.equal(fullXcode.xcodeFullToolchain, true);
});

// --- doctor: sourceRef/sourceCommit/sourceDrift -----------------------------------------

const fakeKeychain = () => ({async get() { return 't'.repeat(43); }, async set() {}, async delete() {}});
const emptyConnectors = () => { const empty = {async readSnapshot() { return []; }, async health() { return {ok: true}; }}; return {jira: empty, calendar: empty, reminders: empty, slack: empty}; };

async function doctorFixture(t, systemProbeOverrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'rhize-tasks-doctor-provenance-'));
  const context = await createServiceContext({
    databasePath: path.join(directory, 'state.sqlite'),
    keychain: fakeKeychain(),
    connectors: emptyConnectors(),
    systemProbe: {
      async agentLoaded() { return null; },
      async plistNodePathExists() { return null; },
      async installedRuntimeVersion() { return null; },
      ...systemProbeOverrides,
    },
  });
  t.after(() => { context.close(); return rm(directory, {recursive: true, force: true}); });
  return context;
}

test('doctor surfaces sourceRef/sourceCommit from installation provenance', async t => {
  const context = await doctorFixture(t, {async installationProvenance() { return {sourceRef: 'v0.5.0', sourceCommit: 'd'.repeat(40)}; }});
  const doctor = await context.doctor();
  assert.equal(doctor.sourceRef, 'v0.5.0');
  assert.equal(doctor.sourceCommit, 'd'.repeat(40));
  assert.equal('sourceDrift' in doctor, false);
});

test('doctor omits sourceDrift when --expect-source-ref is not passed, even with no provenance', async t => {
  const context = await doctorFixture(t, {async installationProvenance() { return null; }});
  const doctor = await context.doctor();
  assert.equal(doctor.sourceRef, null);
  assert.equal(doctor.sourceCommit, null);
  assert.equal('sourceDrift' in doctor, false);
});

test('doctor reports sourceDrift true when --expect-source-ref differs from the installed ref', async t => {
  const context = await doctorFixture(t, {async installationProvenance() { return {sourceRef: 'v0.4.4', sourceCommit: 'e'.repeat(40)}; }});
  const doctor = await context.doctor({expectSourceRef: 'v0.5.0'});
  assert.equal(doctor.sourceDrift, true);
});

test('doctor reports sourceDrift false when --expect-source-ref matches the installed ref', async t => {
  const context = await doctorFixture(t, {async installationProvenance() { return {sourceRef: 'v0.5.0', sourceCommit: 'f'.repeat(40)}; }});
  const doctor = await context.doctor({expectSourceRef: 'v0.5.0'});
  assert.equal(doctor.sourceDrift, false);
});

test('doctor tolerates a systemProbe with no installationProvenance method (pre-existing fakes elsewhere in this suite)', async t => {
  const context = await doctorFixture(t);
  const doctor = await context.doctor();
  assert.equal(doctor.sourceRef, null);
  assert.equal(doctor.sourceCommit, null);
});
