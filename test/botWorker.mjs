// A worker's entry point: Node loads a worker's first file before any loader
// is registered in it, so this registers tsx and then loads the real one.
import { register } from "tsx/esm/api";

register();
await import("./botWorker.ts");
