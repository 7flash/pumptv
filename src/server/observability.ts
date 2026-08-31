import { configure, createMeasure } from "measure-fn";

configure({
  silent: process.env.MEASURE_SILENT !== "0",
  timestamps: process.env.MEASURE_TIMESTAMPS !== "0",
  maxResultLength: 240,
});

export const httpMeasure = createMeasure("http");
export const dbMeasure = createMeasure("db");
export const falMeasure = createMeasure("fal");
export const showrunnerMeasure = createMeasure("showrunner");
export const reconcileMeasure = createMeasure("reconcile");
export const workerMeasure = createMeasure("worker");
export const pumpMeasure = createMeasure("pumpfun");

export const arbitrationMeasure = createMeasure("arbitration");
