/**
 * Type declarations for onnxruntime-node.
 * The actual package is loaded dynamically at runtime — these types
 * allow TypeScript compilation without the package installed.
 */
declare module "onnxruntime-node" {
  export class InferenceSession {
    static create(
      path: string,
      options?: { executionProviders?: string[] },
    ): Promise<InferenceSession>;
    inputNames: string[];
    outputNames: string[];
    run(
      feeds: Record<string, Tensor>,
    ): Promise<Record<string, { data: Float32Array | Int32Array }>>;
  }

  export class Tensor {
    constructor(
      type: string,
      data: Float32Array | Int32Array | Uint8Array,
      dims: number[],
    );
  }
}
