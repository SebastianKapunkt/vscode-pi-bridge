import { build } from 'esbuild';

for (const name of ['vscode', 'pi']) {
  await build({
    entryPoints: [`src/${name}.ts`],
    outfile: `dist/${name}.cjs`,
    bundle: true, platform: 'node', target: 'node22', format: 'cjs',
    external: ['vscode', '@earendil-works/pi-coding-agent', 'bufferutil', 'utf-8-validate'],
    sourcemap: false,
    // Pi imports the CommonJS factory through ESM; avoid a nested default export.
    footer: name === 'pi' ? { js: 'module.exports = module.exports.default;' } : undefined,
  });
}
