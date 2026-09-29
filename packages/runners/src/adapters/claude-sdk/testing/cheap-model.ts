// The model this runner's conformance tests run: its cheap tier's, from its own registration rows
// (a kit names no model; the suite's subject does).
import { MODELS } from "../registration.js";

const cheap = MODELS.find((m) => m.tier === "cheap");
if (cheap === undefined) throw new Error("the runner registers no cheap tier");

export const CHEAP_MODEL: string = cheap.model;
