"use client";

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Barcode,
  Check,
  ChevronDown,
  CirclePlus,
  MoreHorizontal,
  Package,
  Search,
  X,
} from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import "./productos.css";

type Product = {
  id: string;
  name: string;
  category: string;
  dimension: string;
  formats: string;
  locations: string;
  active: boolean;
};

type Dimension = "mass" | "volume" | "count";

type ProductQueryRow = {
  id: string;
  name: string;
  dimension: Dimension;
  active: boolean;
  product_packs: Array<{ active: boolean }>;
  location_products: Array<{ location_id: string; active: boolean }>;
};

const dimensionLabels: Record<Dimension, string> = {
  mass: "Peso",
  volume: "Volumen",
  count: "Unidades",
};

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [query, setQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [dimension, setDimension] = useState<Dimension>("count");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const filtered = products.filter(
    (product) =>
      product.name.toLowerCase().includes(query.toLowerCase()) ||
      product.category.toLowerCase().includes(query.toLowerCase()),
  );

  async function loadProducts() {
    setLoading(true);
    setError("");
    const supabase = createClient();
      if (!supabase) {
        setError("Configura las variables de Supabase para cargar el catálogo.");
        setLoading(false);
        return;
      }
    const { data, error: queryError } = await supabase
      .from("products")
      .select("id, name, dimension, active, product_packs(id, active), location_products(location_id, active)")
      .order("name");

    if (queryError) {
      setError("No se pudo cargar el catálogo. Revisa la conexión e inténtalo de nuevo.");
      setLoading(false);
      return;
    }

    const records = (data ?? []) as ProductQueryRow[];
    setProducts(
      records.map((product) => ({
        id: product.id,
        name: product.name,
        category: "Sin categoría",
        dimension: dimensionLabels[product.dimension],
        formats: `${product.product_packs.filter((pack) => pack.active).length} formatos`,
        locations: `${product.location_products.filter((locationProduct) => locationProduct.active).length} locales`,
        active: product.active,
      })),
    );
    setLoading(false);
  }

  useEffect(() => {
    void loadProducts();
  }, []);

  async function addProduct() {
    const productName = name.trim();
    if (!productName || saving) return;
    setSaving(true);
    setError("");
    const supabase = createClient();
      if (!supabase) {
        setError("Configura las variables de Supabase para crear productos.");
        setSaving(false);
        return;
      }
    const { data: membership, error: membershipError } = await supabase
      .from("memberships")
      .select("org_id")
      .limit(1)
      .maybeSingle();

    if (membershipError || !membership) {
      setError("No se encontró una organización activa para crear el producto.");
      setSaving(false);
      return;
    }

    const { error: insertError } = await supabase.from("products").insert({
      org_id: membership.org_id,
      name: productName,
      dimension,
    });

    if (insertError) {
      setError(insertError.code === "23505" ? "Ya existe un producto con ese nombre." : "No se pudo crear el producto.");
      setSaving(false);
      return;
    }

    setName("");
    setDimension("count");
    setModalOpen(false);
    setSaving(false);
    await loadProducts();
  }

  return (
    <main className="catalog-page">
      <header className="catalog-topbar">
        <Link href="/" className="back-link">
          <ArrowLeft size={16} /> Resumen
        </Link>
        <span className="catalog-title">Catálogo</span>
        <div className="catalog-user">MC</div>
      </header>
      <div className="catalog-content">
        <div className="catalog-heading">
          <div>
            <p className="eyebrow">Parador Eventos · Catálogo común</p>
            <h1>Productos</h1>
            <p className="catalog-subtitle">
              Un solo catálogo para todos tus locales y proveedores.
            </p>
          </div>
          <button
            className="catalog-primary"
            onClick={() => setModalOpen(true)}
            disabled={loading}
          >
            <CirclePlus size={17} /> Nuevo producto
          </button>
        </div>
        <div className="catalog-tabs">
          <button className="active">
            Todos <b>{products.length}</b>
          </button>
          <button>
            Activos <b>{products.filter((product) => product.active).length}</b>
          </button>
          <button>
            Archivados <b>0</b>
          </button>
        </div>
        <section className="catalog-panel">
          <div className="catalog-toolbar">
            <div className="catalog-search">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por nombre o categoría"
              />
            </div>
            <button className="filter-button">
              Categoría <ChevronDown size={15} />
            </button>
            <button className="filter-button">
              Más filtros <ChevronDown size={15} />
            </button>
          </div>
          <div className="catalog-table">
            <div className="catalog-head">
              <span>Producto</span>
              <span>Cómo se mide</span>
              <span>Formatos</span>
              <span>Locales</span>
              <span>Estado</span>
              <span />
            </div>
            {loading && (
              <div className="catalog-empty">
                <strong>Cargando catálogo...</strong>
                <span>Estamos consultando los productos de Parador Eventos.</span>
              </div>
            )}
            {!loading && error && (
              <div className="catalog-empty">
                <strong>No se pudo cargar el catálogo</strong>
                <span>{error}</span>
                <button className="filter-button" onClick={() => void loadProducts()}>
                  Reintentar
                </button>
              </div>
            )}
            {!loading && !error && filtered.map((product) => (
              <div className="catalog-row" key={product.name}>
                <div className="catalog-product">
                  <span className="catalog-product-icon">
                    <Package size={17} />
                  </span>
                  <span>
                    <strong>{product.name}</strong>
                    <small>{product.category}</small>
                  </span>
                </div>
                <span className="dimension-pill">{product.dimension}</span>
                <span>{product.formats}</span>
                <span>{product.locations}</span>
                <span className={`active-status ${product.active ? "" : "inactive-status"}`}>
                  <i /> {product.active ? "Activo" : "Archivado"}
                </span>
                <button
                  className="row-menu"
                  aria-label={`Opciones para ${product.name}`}
                >
                  <MoreHorizontal size={18} />
                </button>
              </div>
            ))}
            {!loading && !error && filtered.length === 0 && (
              <div className="catalog-empty">
                <Search size={20} />
                <strong>No hay resultados</strong>
                <span>Prueba con otro nombre o categoría.</span>
              </div>
            )}
          </div>
        </section>
      </div>
      {modalOpen && (
        <div className="modal-layer" onClick={() => setModalOpen(false)}>
          <section
            className="product-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Alta rápida</p>
                <h2>Nuevo producto</h2>
              </div>
              <button
                className="modal-close"
                onClick={() => setModalOpen(false)}
                aria-label="Cerrar"
              >
                <X size={18} />
              </button>
            </div>
            <label>
              Nombre del producto
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Ej. Ginebra Nordés"
                autoFocus
              />
            </label>
            <label>
              Cómo se mide
              <select
                value={dimension}
                onChange={(event) => setDimension(event.target.value as Dimension)}
              >
                <option value="volume">Volumen (ml)</option>
                <option value="mass">Peso (g)</option>
                <option value="count">Unidades (ud)</option>
              </select>
            </label>
            <label>
              Formato de compra
              <div className="format-input">
                <input placeholder="Ej. Caja 6 x 70 cl" />
                <Barcode size={17} />
              </div>
            </label>
            <div className="modal-note">
              <Check size={15} /> Podrás añadir proveedores y formatos después
            </div>
            <button
              className="catalog-primary modal-submit"
              onClick={addProduct}
              disabled={saving || !name.trim()}
            >
              {saving ? "Guardando..." : "Crear producto"}
            </button>
            {error && <p className="modal-error">{error}</p>}
          </section>
        </div>
      )}
    </main>
  );
}
