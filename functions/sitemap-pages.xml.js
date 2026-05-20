// /sitemap-pages.xml — the actual urlset linked from /sitemap.xml.
// All URL + image entries live here. See sitemap.xml.js for why.
import { pagesUrlset } from './sitemap.xml.js';
export const onRequestGet = pagesUrlset;
