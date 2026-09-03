/**
 * TypeScript type definitions for Schema.org structured data inputs.
 * These types ensure type safety when generating JSON-LD schemas.
 */

/**
 * Common postal address structure.
 */
export interface PostalAddress {
  streetAddress?: string;
  addressLocality?: string;
  addressRegion?: string;
  postalCode?: string;
  addressCountry?: string;
}

/**
 * Geographic coordinates.
 */
export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

/**
 * Opening hours specification.
 */
export interface OpeningHours {
  dayOfWeek: string | string[];
  opens: string;
  closes: string;
}

/**
 * Contact point for organizations.
 */
export interface ContactPoint {
  telephone?: string;
  contactType?: string;
  email?: string;
}

/**
 * Author information (Person or Organization).
 */
export interface Author {
  name?: string;
  url?: string;
}

/**
 * Publisher information (Organization).
 */
export interface Publisher {
  name?: string;
  logo?: string;
}

/**
 * Offer information for products.
 */
export interface Offer {
  url?: string;
  priceCurrency?: string;
  price?: string | number;
  priceValidUntil?: string;
  availability?: string;
  itemCondition?: string;
}

/**
 * Aggregate rating.
 */
export interface AggregateRating {
  ratingValue: number;
  reviewCount: number;
}

/**
 * Breadcrumb list item.
 */
export interface BreadcrumbItem {
  name?: string;
  url?: string;
}

/**
 * Event location.
 */
export interface EventLocation {
  name?: string;
  streetAddress?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}

/**
 * FAQ question and answer.
 */
export interface FAQQuestion {
  question?: string;
  answer?: string;
}

/**
 * Nutrition information.
 */
export interface NutritionInformation {
  calories?: string;
}

/**
 * Organization schema data.
 */
export interface OrganizationData {
  name?: string;
  url?: string;
  logo?: string;
  description?: string;
  email?: string;
  telephone?: string;
  address?: PostalAddress;
  sameAs?: string | string[];
  contactPoint?: ContactPoint;
}

/**
 * Local business schema data.
 */
export interface LocalBusinessData {
  businessType?: string;
  name?: string;
  image?: string | string[];
  id?: string;
  url?: string;
  telephone?: string;
  priceRange?: string;
  address?: PostalAddress;
  geo?: GeoCoordinates;
  openingHours?: OpeningHours[];
}

/**
 * Article schema data (Article, NewsArticle, BlogPosting).
 */
export interface ArticleData {
  articleType?: "Article" | "NewsArticle" | "BlogPosting";
  headline?: string;
  image?: string | string[];
  author?: Author;
  publisher?: Publisher;
  datePublished?: string;
  dateModified?: string;
  description?: string;
}

/**
 * Product schema data.
 */
export interface ProductData {
  name?: string;
  image?: string | string[];
  description?: string;
  sku?: string;
  mpn?: string;
  brand?: string;
  offers?: Offer;
  aggregateRating?: AggregateRating;
}

/**
 * Breadcrumb list schema data.
 */
export interface BreadcrumbListData {
  items: BreadcrumbItem[];
}

/**
 * Website schema data.
 */
export interface WebSiteData {
  name?: string;
  url?: string;
  description?: string;
  searchUrl?: string;
}

/**
 * Person schema data.
 */
export interface PersonData {
  name?: string;
  url?: string;
  image?: string;
  jobTitle?: string;
  worksFor?: string;
  sameAs?: string | string[];
  description?: string;
}

/**
 * Event schema data.
 */
export interface EventData {
  name?: string;
  startDate?: string;
  endDate?: string;
  eventAttendanceMode?: string;
  eventStatus?: string;
  location?: EventLocation;
  image?: string | string[];
  description?: string;
  organizer?: string;
}

/**
 * FAQ page schema data.
 */
export interface FAQPageData {
  questions: FAQQuestion[];
}

/**
 * Recipe schema data.
 */
export interface RecipeData {
  name?: string;
  image?: string | string[];
  author?: Author;
  datePublished?: string;
  description?: string;
  prepTime?: string;
  cookTime?: string;
  totalTime?: string;
  recipeYield?: string;
  recipeCategory?: string;
  recipeCuisine?: string;
  recipeIngredient?: string | string[];
  recipeInstructions?: string | string[];
  nutrition?: NutritionInformation;
}

/**
 * Map of schema types to their data types.
 * This enables type-safe schema generation.
 */
export interface SchemaDataByType {
  Organization: OrganizationData;
  LocalBusiness: LocalBusinessData;
  Article: ArticleData;
  Product: ProductData;
  BreadcrumbList: BreadcrumbListData;
  WebSite: WebSiteData;
  Person: PersonData;
  Event: EventData;
  FAQPage: FAQPageData;
  Recipe: RecipeData;
}
