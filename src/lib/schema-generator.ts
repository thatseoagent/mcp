/**
 * Schema.org JSON-LD template generator.
 * Generates structured data templates for common schema types.
 */

import { validateSchema, type ValidationResult } from "./schema-validator";
import { InvalidInputError } from "./invalid-input-error";
import type {
  SchemaDataByType,
  OrganizationData,
  LocalBusinessData,
  ArticleData,
  ProductData,
  BreadcrumbListData,
  WebSiteData,
  PersonData,
  EventData,
  FAQPageData,
  RecipeData,
} from "./schema-types";

export type SchemaType =
  | "Organization"
  | "LocalBusiness"
  | "Article"
  | "Product"
  | "BreadcrumbList"
  | "WebSite"
  | "Person"
  | "Event"
  | "FAQPage"
  | "Recipe";

export interface SchemaGenerationResult {
  jsonLd: string;
  htmlSnippet: string;
  validation: ValidationResult;
  missingFields: string[];
}

/**
 * Generate JSON-LD structured data from type and data.
 * Type-safe version that uses specific types for each schema.
 */
export function generateSchema<T extends SchemaType>(
  type: T,
  data: SchemaDataByType[T]
): SchemaGenerationResult {
  let schema: Record<string, unknown>;

  switch (type) {
    case "Organization":
      schema = generateOrganizationSchema(data as OrganizationData);
      break;
    case "LocalBusiness":
      schema = generateLocalBusinessSchema(data as LocalBusinessData);
      break;
    case "Article":
      schema = generateArticleSchema(data as ArticleData);
      break;
    case "Product":
      schema = generateProductSchema(data as ProductData);
      break;
    case "BreadcrumbList":
      schema = generateBreadcrumbSchema(data as BreadcrumbListData);
      break;
    case "WebSite":
      schema = generateWebSiteSchema(data as WebSiteData);
      break;
    case "Person":
      schema = generatePersonSchema(data as PersonData);
      break;
    case "Event":
      schema = generateEventSchema(data as EventData);
      break;
    case "FAQPage":
      schema = generateFAQPageSchema(data as FAQPageData);
      break;
    case "Recipe":
      schema = generateRecipeSchema(data as RecipeData);
      break;
    default:
      throw new InvalidInputError(`Unsupported schema type: ${type}`);
  }

  // Validate generated schema
  const validation = validateSchema(schema, type);

  // Identify missing required fields (for placeholders)
  const missingFields: string[] = [];
  const jsonString = JSON.stringify(schema, null, 2);
  const placeholderMatches = jsonString.match(/\[([A-Z_]+)\]/g);
  if (placeholderMatches) {
    for (const match of placeholderMatches) {
      const field = match.slice(1, -1); // Remove brackets
      if (!missingFields.includes(field)) {
        missingFields.push(field);
      }
    }
  }

  // Format JSON-LD
  const jsonLd = JSON.stringify(schema, null, 2);

  // Generate HTML snippet
  const htmlSnippet = `<script type="application/ld+json">\n${jsonLd}\n</script>`;

  return {
    jsonLd,
    htmlSnippet,
    validation,
    missingFields,
  };
}

/**
 * Generate Organization schema.
 */
function generateOrganizationSchema(
  data: OrganizationData
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: data.name || "[ORGANIZATION_NAME]",
    url: data.url || "[ORGANIZATION_URL]",
    logo: data.logo || "[LOGO_URL]",
    description: data.description,
    email: data.email,
    telephone: data.telephone,
    address: data.address
      ? {
          "@type": "PostalAddress",
          streetAddress: data.address.streetAddress,
          addressLocality: data.address.addressLocality,
          addressRegion: data.address.addressRegion,
          postalCode: data.address.postalCode,
          addressCountry: data.address.addressCountry,
        }
      : undefined,
    sameAs: data.sameAs
      ? Array.isArray(data.sameAs)
        ? data.sameAs
        : [data.sameAs]
      : undefined,
    contactPoint: data.contactPoint
      ? {
          "@type": "ContactPoint",
          telephone: data.contactPoint.telephone,
          contactType: data.contactPoint.contactType || "customer service",
          email: data.contactPoint.email,
        }
      : undefined,
  };
}

/**
 * Generate LocalBusiness schema.
 */
function generateLocalBusinessSchema(
  data: LocalBusinessData
): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": data.businessType || "LocalBusiness",
    name: data.name || "[BUSINESS_NAME]",
    image: data.image || "[IMAGE_URL]",
    "@id": data.id || data.url,
    url: data.url,
    telephone: data.telephone || "[PHONE_NUMBER]",
    priceRange: data.priceRange,
    address: {
      "@type": "PostalAddress",
      streetAddress: data.address?.streetAddress || "[STREET_ADDRESS]",
      addressLocality: data.address?.addressLocality || "[CITY]",
      addressRegion: data.address?.addressRegion || "[STATE]",
      postalCode: data.address?.postalCode || "[ZIP]",
      addressCountry: data.address?.addressCountry || "[COUNTRY]",
    },
    geo: data.geo
      ? {
          "@type": "GeoCoordinates",
          latitude: data.geo.latitude,
          longitude: data.geo.longitude,
        }
      : undefined,
    openingHoursSpecification: data.openingHours
      ? data.openingHours.map((hours) => ({
          "@type": "OpeningHoursSpecification",
          dayOfWeek: hours.dayOfWeek,
          opens: hours.opens,
          closes: hours.closes,
        }))
      : undefined,
  };
}

/**
 * Generate Article schema (works for Article, NewsArticle, BlogPosting).
 */
function generateArticleSchema(data: ArticleData): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": data.articleType || "Article",
    headline: data.headline || "[ARTICLE_HEADLINE]",
    image: data.image
      ? Array.isArray(data.image)
        ? data.image
        : [data.image]
      : ["[IMAGE_URL]"],
    author: {
      "@type": "Person",
      name: data.author?.name || "[AUTHOR_NAME]",
      url: data.author?.url,
    },
    publisher: {
      "@type": "Organization",
      name: data.publisher?.name || "[PUBLISHER_NAME]",
      logo: {
        "@type": "ImageObject",
        url: data.publisher?.logo || "[PUBLISHER_LOGO_URL]",
      },
    },
    datePublished: data.datePublished || "[YYYY-MM-DD]",
    dateModified: data.dateModified || data.datePublished || "[YYYY-MM-DD]",
    description: data.description,
  };
}

/**
 * Generate Product schema.
 */
function generateProductSchema(data: ProductData): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Product",
    name: data.name || "[PRODUCT_NAME]",
    image: data.image
      ? Array.isArray(data.image)
        ? data.image
        : [data.image]
      : ["[IMAGE_URL]"],
    description: data.description || "[PRODUCT_DESCRIPTION]",
    sku: data.sku,
    mpn: data.mpn,
    brand: data.brand
      ? {
          "@type": "Brand",
          name: data.brand,
        }
      : undefined,
    offers: {
      "@type": "Offer",
      url: data.offers?.url,
      priceCurrency: data.offers?.priceCurrency || "[CURRENCY_CODE]",
      price: data.offers?.price || "[PRICE]",
      priceValidUntil: data.offers?.priceValidUntil,
      availability: data.offers?.availability || "https://schema.org/InStock",
      itemCondition: data.offers?.itemCondition || "https://schema.org/NewCondition",
    },
    aggregateRating: data.aggregateRating
      ? {
          "@type": "AggregateRating",
          ratingValue: data.aggregateRating.ratingValue,
          reviewCount: data.aggregateRating.reviewCount,
        }
      : undefined,
  };
}

/**
 * Generate BreadcrumbList schema.
 */
function generateBreadcrumbSchema(
  data: BreadcrumbListData
): Record<string, unknown> {
  if (!data.items || !Array.isArray(data.items)) {
    // Names the field, so a caller that omitted it can supply it on the next
    // call. That only works if the message survives the trip to the client,
    // which is what the type is for.
    throw new InvalidInputError("BreadcrumbList requires 'items' array");
  }

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: data.items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name || `[ITEM_${index + 1}_NAME]`,
      item: item.url || `[ITEM_${index + 1}_URL]`,
    })),
  };
}

/**
 * Generate WebSite schema.
 */
function generateWebSiteSchema(data: WebSiteData): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: data.name || "[WEBSITE_NAME]",
    url: data.url || "[WEBSITE_URL]",
    description: data.description,
    potentialAction: data.searchUrl
      ? {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${data.searchUrl}?q={search_term_string}`,
          },
          "query-input": "required name=search_term_string",
        }
      : undefined,
  };
}

/**
 * Generate Person schema.
 */
function generatePersonSchema(data: PersonData): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Person",
    name: data.name || "[PERSON_NAME]",
    url: data.url,
    image: data.image,
    jobTitle: data.jobTitle,
    worksFor: data.worksFor
      ? {
          "@type": "Organization",
          name: data.worksFor,
        }
      : undefined,
    sameAs: data.sameAs
      ? Array.isArray(data.sameAs)
        ? data.sameAs
        : [data.sameAs]
      : undefined,
    description: data.description,
  };
}

/**
 * Generate Event schema.
 */
function generateEventSchema(data: EventData): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: data.name || "[EVENT_NAME]",
    startDate: data.startDate || "[YYYY-MM-DDTHH:MM]",
    endDate: data.endDate,
    eventAttendanceMode: data.eventAttendanceMode || "https://schema.org/OfflineEventAttendanceMode",
    eventStatus: data.eventStatus || "https://schema.org/EventScheduled",
    location: data.location
      ? {
          "@type": "Place",
          name: data.location.name || "[VENUE_NAME]",
          address: {
            "@type": "PostalAddress",
            streetAddress: data.location.streetAddress,
            addressLocality: data.location.city,
            postalCode: data.location.postalCode,
            addressCountry: data.location.country,
          },
        }
      : "[LOCATION]",
    image: data.image
      ? Array.isArray(data.image)
        ? data.image
        : [data.image]
      : undefined,
    description: data.description,
    organizer: data.organizer
      ? {
          "@type": "Organization",
          name: data.organizer,
        }
      : undefined,
  };
}

/**
 * Generate FAQPage schema.
 */
function generateFAQPageSchema(data: FAQPageData): Record<string, unknown> {
  if (!data.questions || !Array.isArray(data.questions)) {
    throw new InvalidInputError("FAQPage requires 'questions' array");
  }

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: data.questions.map((q) => ({
      "@type": "Question",
      name: q.question || "[QUESTION]",
      acceptedAnswer: {
        "@type": "Answer",
        text: q.answer || "[ANSWER]",
      },
    })),
  };
}

/**
 * Generate Recipe schema.
 */
function generateRecipeSchema(data: RecipeData): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: data.name || "[RECIPE_NAME]",
    image: data.image
      ? Array.isArray(data.image)
        ? data.image
        : [data.image]
      : ["[IMAGE_URL]"],
    author: {
      "@type": "Person",
      name: data.author?.name || "[AUTHOR_NAME]",
    },
    datePublished: data.datePublished || "[YYYY-MM-DD]",
    description: data.description || "[RECIPE_DESCRIPTION]",
    prepTime: data.prepTime,
    cookTime: data.cookTime,
    totalTime: data.totalTime,
    recipeYield: data.recipeYield,
    recipeCategory: data.recipeCategory,
    recipeCuisine: data.recipeCuisine,
    recipeIngredient: data.recipeIngredient
      ? Array.isArray(data.recipeIngredient)
        ? data.recipeIngredient
        : [data.recipeIngredient]
      : ["[INGREDIENT_1]", "[INGREDIENT_2]"],
    recipeInstructions: data.recipeInstructions
      ? Array.isArray(data.recipeInstructions)
        ? data.recipeInstructions.map((step, index) => ({
            "@type": "HowToStep",
            position: index + 1,
            text: step,
          }))
        : [
            {
              "@type": "HowToStep",
              text: data.recipeInstructions,
            },
          ]
      : undefined,
    nutrition: data.nutrition
      ? {
          "@type": "NutritionInformation",
          calories: data.nutrition.calories,
        }
      : undefined,
  };
}
