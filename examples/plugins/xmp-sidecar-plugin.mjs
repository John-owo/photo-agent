import { xmpSidecarPlugin } from "../../dist/src/xmp-backend.js";

// Community adapter template: the public loader consumes these two exports.
export const manifest = xmpSidecarPlugin.manifest;
export const create = xmpSidecarPlugin.create;
