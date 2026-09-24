export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      memberships: {
        Row: {
          org_id: string;
          user_id: string;
          role: "owner" | "admin" | "manager" | "staff";
          all_locations: boolean;
          created_at: string;
        };
        Insert: {
          org_id: string;
          user_id: string;
          role?: "owner" | "admin" | "manager" | "staff";
          all_locations?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["memberships"]["Insert"]>;
        Relationships: [];
      };
      locations: {
        Row: {
          id: string;
          org_id: string;
          name: string;
          kind: string;
          timezone: string;
          day_cutoff: string;
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          name: string;
          kind?: string;
          timezone?: string;
          day_cutoff?: string;
          active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["locations"]["Insert"]>;
        Relationships: [];
      };
      suppliers: {
        Row: {
          id: string;
          org_id: string;
          name: string;
          tax_id: string | null;
          email: string | null;
          phone: string | null;
          notes: string | null;
          active: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          name: string;
          tax_id?: string | null;
          email?: string | null;
          phone?: string | null;
          notes?: string | null;
          active?: boolean;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["suppliers"]["Insert"]>;
        Relationships: [];
      };
      products: {
        Row: {
          id: string;
          org_id: string;
          category_id: string | null;
          name: string;
          dimension: "mass" | "volume" | "count";
          base_unit: string;
          sku: string | null;
          track_stock: boolean;
          active: boolean;
          notes: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          org_id: string;
          category_id?: string | null;
          name: string;
          dimension: "mass" | "volume" | "count";
          sku?: string | null;
          track_stock?: boolean;
          active?: boolean;
          notes?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["products"]["Insert"]>;
        Relationships: [];
      };
      product_packs: {
        Row: {
          id: string;
          product_id: string;
          name: string;
          qty_base: number;
          barcode: string | null;
          full_weight_g: number | null;
          empty_weight_g: number | null;
          is_count_default: boolean;
          is_purchase_default: boolean;
          active: boolean;
        };
        Insert: {
          id?: string;
          product_id: string;
          name: string;
          qty_base: number;
          barcode?: string | null;
          full_weight_g?: number | null;
          empty_weight_g?: number | null;
          is_count_default?: boolean;
          is_purchase_default?: boolean;
          active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["product_packs"]["Insert"]>;
        Relationships: [];
      };
      supplier_prices: {
        Row: {
          supplier_id: string;
          pack_id: string;
          supplier_ref: string | null;
          last_price: number | null;
          last_price_at: string | null;
        };
        Insert: {
          supplier_id: string;
          pack_id: string;
          supplier_ref?: string | null;
          last_price?: number | null;
          last_price_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["supplier_prices"]["Insert"]>;
        Relationships: [];
      };
      stock_balances: {
        Row: {
          location_id: string;
          product_id: string;
          qty: number;
          avg_cost: number;
          updated_at: string;
        };
        // Solo lectura: el saldo lo mantiene el trigger de movimientos.
        Insert: Record<string, never>;
        Update: Record<string, never>;
        Relationships: [];
      };
      location_products: {
        Row: {
          location_id: string;
          product_id: string;
          min_qty: number;
          par_qty: number;
          default_area_id: string | null;
          active: boolean;
        };
        Insert: {
          location_id: string;
          product_id: string;
          min_qty?: number;
          par_qty?: number;
          default_area_id?: string | null;
          active?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["location_products"]["Insert"]>;
        Relationships: [];
      };
      goods_receipts: {
        Row: {
          id: string;
          org_id: string;
          location_id: string;
          supplier_id: string | null;
          doc_number: string | null;
          doc_date: string;
          status: "open" | "closed" | "cancelled";
          attachment_path: string | null;
          created_by: string | null;
          created_at: string;
          posted_by: string | null;
          posted_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          location_id: string;
          supplier_id?: string | null;
          doc_number?: string | null;
          doc_date?: string;
          status?: "open" | "closed" | "cancelled";
          attachment_path?: string | null;
          created_by?: string | null;
          created_at?: string;
          posted_by?: string | null;
          posted_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["goods_receipts"]["Insert"]>;
        Relationships: [];
      };
      receipt_lines: {
        Row: {
          id: string;
          receipt_id: string;
          pack_id: string;
          packs_qty: number;
          pack_price: number;
        };
        Insert: {
          id?: string;
          receipt_id: string;
          pack_id: string;
          packs_qty: number;
          pack_price: number;
        };
        Update: Partial<Database["public"]["Tables"]["receipt_lines"]["Insert"]>;
        Relationships: [];
      };
      categories: {
        Row: {
          id: string;
          org_id: string;
          parent_id: string | null;
          name: string;
          sort_order: number;
        };
        Insert: {
          id?: string;
          org_id: string;
          parent_id?: string | null;
          name: string;
          sort_order?: number;
        };
        Update: Partial<Database["public"]["Tables"]["categories"]["Insert"]>;
        Relationships: [];
      };
      stock_movements: {
        Row: {
          id: number;
          org_id: string;
          location_id: string;
          product_id: string;
          area_id: string | null;
          type: "opening" | "purchase" | "consumption" | "waste" | "transfer_out" | "transfer_in" | "count_adjustment" | "manual_adjustment";
          qty: number;
          unit_cost: number | null;
          reason: string | null;
          ref_table: string | null;
          ref_id: string | null;
          client_ref: string | null;
          occurred_at: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: {
          id?: number;
          org_id: string;
          location_id: string;
          product_id: string;
          area_id?: string | null;
          type: "opening" | "purchase" | "consumption" | "waste" | "transfer_out" | "transfer_in" | "count_adjustment" | "manual_adjustment";
          qty: number;
          unit_cost?: number | null;
          reason?: string | null;
          ref_table?: string | null;
          ref_id?: string | null;
          client_ref?: string | null;
          occurred_at?: string;
          created_by?: string | null;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["stock_movements"]["Insert"]>;
        Relationships: [];
      };
      transfers: {
        Row: {
          id: string;
          org_id: string;
          from_location_id: string;
          to_location_id: string;
          status: "draft" | "in_transit" | "received" | "cancelled";
          note: string | null;
          created_by: string | null;
          created_at: string;
          sent_by: string | null;
          sent_at: string | null;
          received_by: string | null;
          received_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          from_location_id: string;
          to_location_id: string;
          status?: "draft" | "in_transit" | "received" | "cancelled";
          note?: string | null;
          created_by?: string | null;
          created_at?: string;
          sent_by?: string | null;
          sent_at?: string | null;
          received_by?: string | null;
          received_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["transfers"]["Insert"]>;
        Relationships: [];
      };
      transfer_lines: {
        Row: {
          id: string;
          transfer_id: string;
          product_id: string;
          qty_sent: number;
          qty_received: number | null;
          unit_cost: number | null;
        };
        Insert: {
          id?: string;
          transfer_id: string;
          product_id: string;
          qty_sent: number;
          qty_received?: number | null;
          unit_cost?: number | null;
        };
        Update: Partial<Database["public"]["Tables"]["transfer_lines"]["Insert"]>;
        Relationships: [];
      };
      inventory_counts: {
        Row: {
          id: string;
          org_id: string;
          location_id: string;
          status: "open" | "closed" | "cancelled";
          note: string | null;
          started_by: string | null;
          started_at: string;
          closed_by: string | null;
          closed_at: string | null;
        };
        Insert: {
          id?: string;
          org_id: string;
          location_id: string;
          status?: "open" | "closed" | "cancelled";
          note?: string | null;
          started_by?: string | null;
          started_at?: string;
          closed_by?: string | null;
          closed_at?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["inventory_counts"]["Insert"]>;
        Relationships: [];
      };
      count_lines: {
        Row: {
          id: string;
          count_id: string;
          product_id: string;
          area_id: string | null;
          qty: number;
          input: Json | null;
          counted_by: string | null;
          counted_at: string;
          client_ref: string | null;
        };
        Insert: {
          id?: string;
          count_id: string;
          product_id: string;
          area_id?: string | null;
          qty: number;
          input?: Json | null;
          counted_by?: string | null;
          counted_at?: string;
          client_ref?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["count_lines"]["Insert"]>;
        Relationships: [];
      };
      count_results: {
        Row: {
          count_id: string;
          product_id: string;
          expected_qty: number;
          counted_qty: number;
          diff_qty: number;
          unit_cost: number;
        };
        Insert: {
          count_id: string;
          product_id: string;
          expected_qty: number;
          counted_qty: number;
          unit_cost: number;
        };
        Update: Partial<Database["public"]["Tables"]["count_results"]["Insert"]>;
        Relationships: [];
      };
    };
    Views: {
      v_stock_valuation: {
        Row: {
          org_id: string;
          location_id: string;
          location_name: string;
          product_id: string;
          product_name: string;
          category_id: string | null;
          category_name: string | null;
          base_unit: string;
          qty: number;
          avg_cost: number;
          stock_value: number;
          min_qty: number | null;
          par_qty: number | null;
          below_min: boolean;
          suggested_order_qty: number;
        };
        Relationships: [];
      };
      v_stock_area_valuation: {
        Row: {
          org_id: string;
          location_id: string;
          area_id: string;
          location_name: string;
          area_name: string;
          product_id: string;
          product_name: string;
          category_id: string | null;
          category_name: string | null;
          base_unit: string;
          qty: number;
          avg_cost: number;
          stock_value: number;
          updated_at: string;
        };
        Relationships: [];
      };
      v_movements_by_business_day: {
        Row: {
          org_id: string;
          location_id: string;
          product_id: string;
          type: "opening" | "purchase" | "consumption" | "waste" | "transfer_out" | "transfer_in" | "count_adjustment" | "manual_adjustment";
          business_day: string;
          qty: number;
          value: number | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      register_movement: {
        Args: {
          p_location: string;
          p_product: string;
          p_type: "opening" | "purchase" | "consumption" | "waste" | "transfer_out" | "transfer_in" | "count_adjustment" | "manual_adjustment";
          p_qty: number;
          p_reason?: string | null;
          p_area?: string | null;
          p_unit_cost?: number | null;
          p_client_ref?: string | null;
        };
        Returns: number;
      };
      send_transfer: { Args: { p_transfer: string }; Returns: undefined };
      receive_transfer: { Args: { p_transfer: string; p_lines?: Json }; Returns: undefined };
      cancel_transfer: { Args: { p_transfer: string }; Returns: undefined };
      close_count: { Args: { p_count: string; p_zero_uncounted?: boolean }; Returns: undefined };
      post_receipt: { Args: { p_receipt: string }; Returns: undefined };
      create_organization: { Args: { p_name: string; p_business_type?: string }; Returns: string };
      catalog_search: {
        Args: {
          p_search?: string | null;
          p_category?: string | null;
          p_supplier?: string | null;
          p_location?: string | null;
          p_dimension?: string | null;
          p_status?: string;
          p_stock?: string | null;
          p_sort?: string;
          p_no_category?: boolean;
          p_limit?: number;
          p_offset?: number;
        };
        Returns: Json;
      };
      consumption_by_business_day: {
        Args: {
          p_since: string;
          p_types: string[];
        };
        Returns: Array<{ business_day: string; value: number | null }>;
      };
      stock_summary: {
        Args: Record<string, never>;
        Returns: Array<{ total_value: number; below_min_count: number; critical_count: number }>;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
