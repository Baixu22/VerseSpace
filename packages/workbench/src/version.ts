import pkg from "../package.json";

/** Single source of truth is package.json; the CLI just reports it. */
export const WORKBENCH_VERSION: string = pkg.version;
