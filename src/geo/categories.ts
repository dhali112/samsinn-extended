// ============================================================================
// Categories — derived from features. No registry file.
//
// loadRegistry walks all features (local + discovered, merged) and
// projects per-category metadata. A category exists iff at least one
// feature in any source carries that category id. Display name, icon,
// and Overpass query template come from feature properties via
// projection.ts (first feature carrying each metadata field wins;
// fallback to title-case id, 'pin' icon, no osmQuery).
//
// Mutations: there are no upsertCategory / deleteCategory operations.
// To "create" a category, write a feature with a new category id (see
// upsertFeature). To "delete" a category, remove all its features (see
// removeCategory in store.ts).
// ============================================================================

import { listAllFeatures, listCategory } from './store.ts'
import { extractCategoryMetaFromFeatures } from './projection.ts'
import type { CategoryMeta } from './types.ts'

export const loadRegistry = async (): Promise<ReadonlyArray<CategoryMeta>> => {
  const features = await listAllFeatures()
  return [...extractCategoryMetaFromFeatures(features).values()]
}

export const listCategories = async (): Promise<ReadonlyArray<CategoryMeta>> =>
  loadRegistry()

export const getCategory = async (id: string): Promise<CategoryMeta | null> => {
  const features = await listCategory(id)
  if (features.length === 0) return null
  const map = extractCategoryMetaFromFeatures(features)
  return map.get(id) ?? null
}
