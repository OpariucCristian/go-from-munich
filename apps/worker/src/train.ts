/**
 * Training pipeline: export features (Node) → train LightGBM (Python) → register/promote.
 *
 * The trainer runs either as a local Python (TRAINER=python, default in the production image)
 * or through the gfm-trainer Docker image (TRAINER=docker, handy on dev machines without Python).
 * Paths passed to the trainer are relative to the repo root, which is mounted at /app in Docker.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CityConfig } from '@gfm/core';
import { startJob } from '@gfm/db';
import { exportTrainingData, registerAndMaybePromote } from '@gfm/model';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: repoRoot, stdio: 'inherit', env: process.env });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

export function runTrainer(dataDir: string, outDir: string): Promise<void> {
  const args = ['--data', dataDir, '--out', outDir];
  if ((process.env.TRAINER ?? 'python') === 'docker') {
    return run('docker', ['run', '--rm', '-v', `${repoRoot}:/app`, '-w', '/app', process.env.TRAINER_IMAGE ?? 'gfm-trainer', ...args]);
  }
  return run(process.env.PYTHON ?? 'python3', ['ml/train.py', ...args]);
}

export async function trainAndPromote(city: CityConfig) {
  const finish = await startJob('train', city.id);
  try {
    const version = `lgbm-${city.id}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}`;
    const dataDir = path.join('data', 'training', city.id);
    const outDir = path.join('models', version);
    const exported = await exportTrainingData(city, { outDir: path.join(repoRoot, dataDir) });
    console.log(`[train] exported train=${exported.train.rows} valid=${exported.valid.rows}`);
    await runTrainer(dataDir.replace(/\\/g, '/'), outDir.replace(/\\/g, '/'));
    const result = await registerAndMaybePromote(path.join(repoRoot, outDir), version);
    const stats = { version, trainRows: exported.train.rows, validRows: exported.valid.rows, ...result };
    await finish('ok', stats);
    return stats;
  } catch (err) {
    await finish('failed', { error: String(err) });
    throw err;
  }
}
