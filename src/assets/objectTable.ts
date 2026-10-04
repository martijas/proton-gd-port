// Loads assets/objects.json: one fetch that gives both the simulation's object
// table and the renderer's art records.
//
// Dev and production read the same built file, so there is no branch here that
// could quietly rot the way the old "derive it in the browser" path did.

import { objectTableFromRecords } from "../physics/objects";
import type { ObjectTable } from "../physics/types";
import type { ObjectRecord, ObjectsFile } from "./objectTypes";
import { fetchAsset } from "./paths";

export interface ObjectData {
  /** Hitboxes and kinds, for the simulation. */
  table: ObjectTable;
  /** Frames, children, colours and z order, for the renderer. */
  render(id: number): ObjectRecord | undefined;
  /** Ids the official levels use, ascending. */
  census: readonly number[];
  file: ObjectsFile;
}

export async function loadObjects(): Promise<ObjectData> {
  const file = await fetchAsset<ObjectsFile>("objects.json");
  const table = objectTableFromRecords(file.objects);
  return {
    table,
    render: (id) => file.objects[String(id)],
    census: file.census,
    file,
  };
}
