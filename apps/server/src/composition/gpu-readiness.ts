import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RequiredGpu } from "../config/schema.js";

const execute = promisify(execFile);
type Runner = (file: string, args: string[], signal: AbortSignal) => Promise<string>;
const run: Runner = async (file, args, signal) => (await execute(file, args, {
  signal, timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 32_768, encoding: "utf8"
})).stdout;
const rows = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).map(line => line.split(",").map(value => value.trim()));
const bus = (value: string) => /^(?:0000)?[a-f0-9]{4}:[a-f0-9]{2}:[a-f0-9]{2}\.[0-7]$/i.test(value) ? value.toLowerCase().slice(-12) : null;

/** Local NVIDIA/llama.cpp opt-in only. Prove the expected device is visible
 * and the configured service actually owns a compute context there. An HTTP
 * tokenizer or CPU response is insufficient. Do not collect utilization,
 * memory, timestamps or slot/busy state, or publish changing process IDs. */
export async function expectedGpuReady(required: RequiredGpu, signal: AbortSignal, execute: Runner = run): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(1_000)]);
  const pid = () => execute("/usr/bin/systemctl", ["--user", "show", required.serviceUnit, "--property=MainPID", "--value"], bounded);
  try {
    const before = (await pid()).trim();
    if (!/^[1-9][0-9]*$/.test(before)) return false;
    const [devices, processes] = await Promise.all([
      execute("/usr/bin/nvidia-smi", ["--query-gpu=pci.bus_id,uuid", "--format=csv,noheader,nounits"], bounded),
      execute("/usr/bin/nvidia-smi", ["--query-compute-apps=gpu_uuid,pid", "--format=csv,noheader,nounits"], bounded)
    ]);
    const matches = rows(devices).filter(row => row.length === 2 && bus(row[0]!) === required.pciBusId);
    if (matches.length !== 1 || !/^GPU-[a-f0-9-]+$/i.test(matches[0]![1]!)) return false;
    const uuid = matches[0]![1];
    return rows(processes).some(row => row.length === 2 && row[0] === uuid && row[1] === before) && (await pid()).trim() === before;
  } catch {
    // Missing executable, access denial, driver error, timeout and a vanished
    // GPU all mean unavailable; never retry or substitute CPU/another device.
    return false;
  }
}
