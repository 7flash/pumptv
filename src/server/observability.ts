import { configure, createMeasure } from "measure-fn";

configure({
  timestamps: process.env.MEASURE_TIMESTAMPS !== "0",
  maxResultLength: 240,
});

export const httpMeasure = createMeasure("http");
export const dbMeasure = createMeasure("db");
export const falMeasure = createMeasure("fal");
