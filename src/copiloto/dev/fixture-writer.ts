// Escritura simulada (desarrollo sin Supabase y tests): registra las llamadas, no mueve datos.
import { randomUUID } from "node:crypto";
import { RpcError, type InventoryWriter, type RpcErrorCode } from "../drafts/writer-port";

export type WriterCall = { method: keyof InventoryWriter; args: unknown };

export class FixtureWriter implements InventoryWriter {
  readonly calls: WriterCall[] = [];
  /** Método que debe fallar y con qué código. */
  failOn: { method: keyof InventoryWriter; code: RpcErrorCode } | null = null;
  #movement = 1000;

  private record(method: keyof InventoryWriter, args: unknown): void {
    this.calls.push({ method, args });
    if (this.failOn?.method === method) throw new RpcError(this.failOn.code, `${method}: ${this.failOn.code}`);
  }

  async registerWaste(args: Parameters<InventoryWriter["registerWaste"]>[0]) {
    this.record("registerWaste", args);
    this.#movement += 1;
    return { movementId: String(this.#movement) };
  }

  async createTransfer(args: Parameters<InventoryWriter["createTransfer"]>[0]) {
    this.record("createTransfer", args);
    return { transferId: randomUUID() };
  }

  async sendTransfer(transferId: string) {
    this.record("sendTransfer", { transferId });
  }

  async deleteDraftTransfer(transferId: string) {
    this.record("deleteDraftTransfer", { transferId });
  }

  async createReceipt(args: Parameters<InventoryWriter["createReceipt"]>[0]) {
    this.record("createReceipt", args);
    return { receiptId: randomUUID() };
  }

  async postReceipt(receiptId: string) {
    this.record("postReceipt", { receiptId });
  }

  async deleteOpenReceipt(receiptId: string) {
    this.record("deleteOpenReceipt", { receiptId });
  }

  async closeCount(countId: string, zeroUncounted: boolean, asConsumption: boolean) {
    this.record("closeCount", { countId, zeroUncounted, asConsumption });
  }

  async setSupplierPrice(args: Parameters<InventoryWriter["setSupplierPrice"]>[0]) {
    this.record("setSupplierPrice", args);
  }

  async createProduct(args: Parameters<InventoryWriter["createProduct"]>[0]) {
    this.record("createProduct", args);
    return { productId: randomUUID() };
  }

  async setLocationLevel(args: Parameters<InventoryWriter["setLocationLevel"]>[0]) {
    this.record("setLocationLevel", args);
  }

  async archiveProduct(productId: string) {
    this.record("archiveProduct", { productId });
  }
}
