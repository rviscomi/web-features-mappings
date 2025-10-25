// The script partially updates the mdn-docs.json mapping file.
// Partially, because the mdn-docs.json file is mostly maintained manually.
// This script adds missing web-features IDs to the mdn-docs.json file
// and updates docs URLs when possible, meaning when the BCD keys which a 
// feature depends on have a single MDN URL.
// Indeed, if we unconditionally used all the MDN URLs from the BCD keys of
// a feature, we would sometimes end up with many URLs for a single feature,
// which is not helpful for consumers of the data.

// To add a new web-features-to-MDN mapping manually, do this:
//
// - Open the `mappings/mdn-docs.json` file.
// - Use the web-features ID as a new top-level object key.
// - Make the value an array of objects, with at least one object.
// - In this object, add the `slug` property only.
// - The other properties will be filled in automatically by this script.

import path from "path";
import fs from "fs/promises";
import { features } from "web-features";
import bcd from "@mdn/browser-compat-data" with { type: "json" };
import mdnInventory from "@ddbeck/mdn-content-inventory";
import existingMapping from "../mappings/mdn-docs.json" with { type: "json" };

const OUTPUT_FILE = path.join(import.meta.dirname, "../mappings/mdn-docs.json");
const MAX_NUMBER_OF_ALLOWED_MDN_URLS = 4;
const MDN_URL_ROOT = "https://developer.mozilla.org/docs/";
const EN_MDN_URL_ROOT = "https://developer.mozilla.org/en-US/docs/";

function getFeatureMDNSlugsFromBCDKeys(id) {
  const feature = features[id];
  const slugs = new Set();

  const keys = feature.compat_features;
  if (!keys || !Array.isArray(keys)) {
    return [];
  }

  for (const key of keys) {
    const keyParts = key.split(".");

    // Traverse the BCD data structure to find the mdn_url properties for this key.
    let data = bcd;
    for (const part of keyParts) {
      if (!data || !data[part]) {
        console.warn(
          `No BCD data for ${key}. Check if the web-features and browser-compat-data dependencies are in sync.`
        );
        continue;
      }
      data = data[part];
    }

    let url = data?.__compat?.mdn_url;
    if (url) {
      slugs.add(url.replace(MDN_URL_ROOT, ""));
    }
  }

  return [...slugs];
}

async function checkForRedirect(slug) {
  // We use the en-US URL to avoid the language-specific redirects.
  const url = EN_MDN_URL_ROOT + slug;
  const request = new Request(url, {redirect: 'manual'});
  const response = await fetch(request);

  if (response.status === 301 || response.status === 302) {
    const location = response.headers.get("Location");
    if (location) {
      return location.replace("/en-US/docs/", "");
    }
  }

  // No redirect found.
  return null;
}

async function main() {
  // Go over all features from the web-features package to possibly add
  // new MDN URLs to the mapping file automatically.
  for (const id in features) {
    // If we already have a mapping for this feature, skip it.
    // Mappings are mostly manual, and we don't want to override them.
    if (existingMapping[id] && existingMapping[id].length) {
      continue;
    }

    // No mapping found, let's look at the MDN URLs from the BCD keys.
    const mdnSlugsBasedOnBCDKeys = getFeatureMDNSlugsFromBCDKeys(id);

    // If there's only a few MDN URLs, add them to the mapping, it's most
    // likely the right ones.
    if (mdnSlugsBasedOnBCDKeys.length > 0 && mdnSlugsBasedOnBCDKeys.length <= MAX_NUMBER_OF_ALLOWED_MDN_URLS) {
      existingMapping[id] = mdnSlugsBasedOnBCDKeys.map(slug => {
        return { slug };
      });
      continue;
    }
  }

  // Use the content inventory to add helpful page/section titles.
  for (const id in existingMapping) {
    const mappings = existingMapping[id];
    for (const mapping of mappings) {
      const slug = mapping.slug;
      const slugParts = slug.split("#");
      const hasAnchor = slugParts.length > 1;

      // Find the corresponding MDN article in the inventory.
      let mdnData = mdnInventory.inventory.find(item => {
        return item.frontmatter.slug === (hasAnchor ? slugParts[0] : slug);
      });

      if (!mdnData) {
        const redirectedSlug = await checkForRedirect(slug);
        if (!redirectedSlug) {
          throw new Error(`No MDN data found for slug: ${slug} and no redirect detected. Please fix the mapping manually for ${id}.`);
        } else {
          console.log(`Redirect found for slug: ${slug}. Using redirected slug: ${redirectedSlug}.`);

          mdnData = mdnInventory.inventory.find(item => {
            return item.frontmatter.slug === (hasAnchor ? redirectedSlug.split("#")[0] : redirectedSlug);
          });

          mapping.slug = redirectedSlug;
        }
      } else {
        mapping.title = mdnData.frontmatter.title;
        mapping.anchor = hasAnchor ? slugParts[1] : null;
        mapping.url = MDN_URL_ROOT + mdnData.frontmatter.slug + (hasAnchor ? `#${slugParts[1]}` : "");

        // TODO: Augment MDN metadata with additional links from the "See more" section of the article
        // Use the `slug` value to look up the article in the `../../content` repository
        // Markdown appears as:
        // ## See also
        //- [`<input type="date">`](/en-US/docs/Web/HTML/Reference/Elements/input/date)
        //- [`<input type="datetime-local">`](/en-US/docs/Web/HTML/Reference/Elements/input/datetime-local)
        // Parse the markdown file to extract the "See more" section links
        // Add those links to the mapping object under a new property, e.g., `seeAlsoLinks`
        // Apply the following rules to convert the slug to the file path:
        // - Lowercase the slug
        // - Replace `::` with `_doublecolon_`
        // - Replace `:` with `_colon_`
        // - Replace `*` with `_star_`
        mapping.seeAlsoLinks = [];
        const filePath = mdnData.frontmatter.slug
          .toLowerCase()
          .replace(/::/g, "_doublecolon_")
          .replace(/:/g, "_colon_")
          .replace(/\*/g, "_star_");
        const contentRepoPath = path.join(import.meta.dirname, "../../content/files/en-us/", filePath + "/index.md");
        try {
          const fileContent = await fs.readFile(contentRepoPath, "utf-8");
          // Match 'See also' or 'See more', case-insensitive, flexible line endings
          const seeAlsoSectionMatch = fileContent.match(/## (See also|See more)\s*\r?\n([\s\S]*?)(\n## |$)/i);
          if (seeAlsoSectionMatch) {
            // Only match external markdown links (http/https)
            const links = seeAlsoSectionMatch[2].match(/- \[([^\]]+)\]\((https?:[^)]+)\)/g);
            if (links) {
              mapping.seeAlsoLinks = links.map(link => {
                const match = link.match(/- \[([^\]]+)\]\((https?:[^)]+)\)/);
                return { text: match[1], url: match[2] };
              });
            }
          }
        } catch (error) {
          console.error(`Error reading content file at ${contentRepoPath}:`, error);
        }
      }
    }
  }

  // Write the JSON file back to disk.
  const str = JSON.stringify(existingMapping, null, 2);
  await fs.writeFile(OUTPUT_FILE, str);
}

main();
