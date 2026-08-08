"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractMetaInformation = extractMetaInformation;
exports.findBook = findBook;
exports.verifyDownload = verifyDownload;
exports.downloadBook = downloadBook;
exports.bookToString = bookToString;
exports.bookToJSON = bookToJSON;
exports.readCSV = readCSV;
exports.updateCSVStatus = updateCSVStatus;
exports.loadConfig = loadConfig;
exports.filterBooks = filterBooks;
exports.processCSV = processCSV;
require("dotenv/config");
var axios_1 = require("axios");
var cheerio = require("cheerio");
var fs = require("fs");
var path = require("path");
var promises_1 = require("stream/promises");
var sync_1 = require("csv-parse/sync");
var sync_2 = require("csv-stringify/sync");
// Constants
var ANNAS_SEARCH_ENDPOINT = 'https://annas-archive.gl/search?q=';
var ANNAS_DOWNLOAD_ENDPOINT = 'https://annas-archive.gl/dyn/api/fast_download.json';
/**
 * Custom error for rate limiting (429 responses)
 */
var RateLimitError = /** @class */ (function (_super) {
    __extends(RateLimitError, _super);
    function RateLimitError(message, retryAfter) {
        var _this = _super.call(this, message) || this;
        _this.name = 'RateLimitError';
        _this.retryAfter = retryAfter;
        return _this;
    }
    return RateLimitError;
}(Error));
/**
 * Extract metadata information from meta string
 */
function extractMetaInformation(meta) {
    // New format: "English [en] · EPUB · 0.4MB"
    var parts = meta.split(' · ');
    if (parts.length < 3) {
        return { language: '', format: '', size: '' };
    }
    return {
        language: parts[0],
        format: parts[1],
        size: parts[2],
    };
}
/**
 * Find books by search query
 */
function findBook(query) {
    return __awaiter(this, void 0, void 0, function () {
        var encodedQuery, fullURL, response, $_1, bookList_1, error_1, retryAfter;
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    encodedQuery = encodeURIComponent(query);
                    fullURL = "".concat(ANNAS_SEARCH_ENDPOINT).concat(encodedQuery);
                    _b.label = 1;
                case 1:
                    _b.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, axios_1.default.get(fullURL, {
                            headers: {
                                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                            },
                        })];
                case 2:
                    response = _b.sent();
                    $_1 = cheerio.load(response.data);
                    bookList_1 = [];
                    $_1('a[href^="/md5/"]').each(function (_, element) {
                        var $el = $_1(element);
                        // Only process the main book link, not cover images
                        if ($el.hasClass('custom-a') && $el.hasClass('block')) {
                            return; // Skip cover image links
                        }
                        var $container = $el.closest('div').parent();
                        // Title is in the link itself
                        var title = $el.text();
                        // Meta info is in the last div (contains language, format, size)
                        // Extract just the text before "Save" button
                        var metaDiv = $container.find('div.text-gray-800');
                        var metaText = metaDiv.contents().filter(function (_, el) { return el.type === 'text'; }).text();
                        var meta = metaText.split('·').slice(0, 3).join('·').trim();
                        // Author link
                        var authors = $container.find('a[href*="/search?q="]').first().text().trim();
                        // Publisher link
                        var publisher = $container.find('a[href*="/search?q="]').eq(1).text().trim();
                        // Extract download count - look for text like "123 downloads"
                        // Download count is typically in a div with download statistics
                        var downloadCount = 0;
                        var downloadText = $container.text().match(/(\d+(?:,\d+)?)\s*downloads?/i);
                        if (downloadText) {
                            downloadCount = parseInt(downloadText[1].replace(/,/g, ''), 10);
                        }
                        var _a = extractMetaInformation(meta), language = _a.language, format = _a.format, size = _a.size;
                        var link = $el.attr('href') || '';
                        var hash = link.replace('/md5/', '');
                        var book = {
                            language: language.trim(),
                            format: format.trim().replace(/[\[\]]/g, ''), // Remove brackets
                            size: size.trim(),
                            title: title.trim(),
                            publisher: publisher.trim(),
                            authors: authors.trim(),
                            url: new URL(link, fullURL).href,
                            hash: hash,
                            downloadCount: downloadCount,
                        };
                        bookList_1.push(book);
                    });
                    return [2 /*return*/, bookList_1];
                case 3:
                    error_1 = _b.sent();
                    // Check for 429 rate limit
                    if (((_a = error_1.response) === null || _a === void 0 ? void 0 : _a.status) === 429) {
                        retryAfter = error_1.response.headers['retry-after']
                            ? parseInt(error_1.response.headers['retry-after'], 10)
                            : undefined;
                        throw new RateLimitError('Rate limit exceeded (429)', retryAfter);
                    }
                    throw new Error("Failed to find books: ".concat(error_1));
                case 4: return [2 /*return*/];
            }
        });
    });
}
/**
 * Verify that a downloaded file exists and is valid
 */
function verifyDownload(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            return false;
        }
        var stats = fs.statSync(filePath);
        return stats.size > 0;
    }
    catch (error) {
        return false;
    }
}
/**
 * Download a book to specified folder
 */
function downloadBook(book, secretKey, folderPath) {
    return __awaiter(this, void 0, void 0, function () {
        var apiURL, apiResp, _a, download_url, error, downloadResp, filename, filePath, writer, error_2, retryAfter;
        var _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    apiURL = "".concat(ANNAS_DOWNLOAD_ENDPOINT, "?md5=").concat(book.hash, "&key=").concat(secretKey);
                    _c.label = 1;
                case 1:
                    _c.trys.push([1, 5, , 6]);
                    return [4 /*yield*/, axios_1.default.get(apiURL)];
                case 2:
                    apiResp = _c.sent();
                    _a = apiResp.data, download_url = _a.download_url, error = _a.error;
                    if (!download_url) {
                        throw new Error(error || 'Failed to get download URL');
                    }
                    return [4 /*yield*/, axios_1.default.get(download_url, {
                            responseType: 'stream',
                        })];
                case 3:
                    downloadResp = _c.sent();
                    if (downloadResp.status !== 200) {
                        throw new Error('Failed to download file');
                    }
                    filename = "".concat(book.title, ".").concat(book.format);
                    filename = filename.replace(/\//g, ''); // Remove slashes
                    filePath = path.join(folderPath, filename);
                    writer = fs.createWriteStream(filePath);
                    return [4 /*yield*/, (0, promises_1.pipeline)(downloadResp.data, writer)];
                case 4:
                    _c.sent();
                    return [3 /*break*/, 6];
                case 5:
                    error_2 = _c.sent();
                    // Check for 429 rate limit
                    if (((_b = error_2.response) === null || _b === void 0 ? void 0 : _b.status) === 429) {
                        retryAfter = error_2.response.headers['retry-after']
                            ? parseInt(error_2.response.headers['retry-after'], 10)
                            : undefined;
                        throw new RateLimitError('Rate limit exceeded (429)', retryAfter);
                    }
                    throw new Error("Failed to download book: ".concat(error_2));
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Convert book to string representation
 */
function bookToString(book) {
    return "Title: ".concat(book.title, "\nAuthors: ").concat(book.authors, "\nPublisher: ").concat(book.publisher, "\nLanguage: ").concat(book.language, "\nFormat: ").concat(book.format, "\nSize: ").concat(book.size, "\nURL: ").concat(book.url, "\nHash: ").concat(book.hash);
}
/**
 * Convert book to JSON string
 */
function bookToJSON(book) {
    return JSON.stringify(book, null, 2);
}
/**
 * Read and parse CSV file containing book information
 */
function readCSV(csvPath) {
    var fileContent = fs.readFileSync(csvPath, 'utf-8');
    var records = (0, sync_1.parse)(fileContent, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
    });
    return records;
}
/**
 * Update CSV file with status for a specific row
 */
function updateCSVStatus(csvPath, rowIndex, status) {
    var rows = readCSV(csvPath);
    // Update the status for the specified row
    if (rowIndex >= 0 && rowIndex < rows.length) {
        rows[rowIndex].status = status;
    }
    // Write back to CSV
    var output = (0, sync_2.stringify)(rows, {
        header: true,
        columns: ['author', 'title', 'status'],
    });
    fs.writeFileSync(csvPath, output, 'utf-8');
}
/**
 * Load configuration from environment variables
 */
function loadConfig() {
    var secretKey = process.env.ANNAS_SECRET_KEY;
    var outputFolder = process.env.OUTPUT_FOLDER || './downloads';
    var maxDownloads = process.env.MAX_DOWNLOADS ? parseInt(process.env.MAX_DOWNLOADS, 10) : undefined;
    if (!secretKey) {
        throw new Error('ANNAS_SECRET_KEY environment variable is required');
    }
    // Create output folder if it doesn't exist
    if (!fs.existsSync(outputFolder)) {
        fs.mkdirSync(outputFolder, { recursive: true });
    }
    return {
        secretKey: secretKey,
        outputFolder: outputFolder,
        preferredFormat: process.env.PREFERRED_FORMAT,
        preferredLanguage: process.env.PREFERRED_LANGUAGE,
        maxDownloads: maxDownloads,
    };
}
/**
 * Filter books based on preferences
 */
function filterBooks(books, config) {
    if (books.length === 0)
        return null;
    var filtered = __spreadArray([], books, true); // Create a copy to avoid mutating the original array
    // Filter by language if specified
    if (config.preferredLanguage) {
        var byLanguage = filtered.filter(function (b) { return b.language.toLowerCase() === config.preferredLanguage.toLowerCase(); });
        if (byLanguage.length > 0)
            filtered = byLanguage;
    }
    // Filter by format if specified
    if (config.preferredFormat) {
        var byFormat = filtered.filter(function (b) { return b.format.toLowerCase() === config.preferredFormat.toLowerCase(); });
        if (byFormat.length > 0)
            filtered = byFormat;
    }
    // Sort by download count (highest first) and return most downloaded
    filtered.sort(function (a, b) { return b.downloadCount - a.downloadCount; });
    return filtered[0] || null;
}
/**
 * Process CSV and download all books
 */
function processCSV(csvPath, config) {
    return __awaiter(this, void 0, void 0, function () {
        var rows, totalBooks, maxDownloads, successCount, failCount, skippedCount, i, row, bookNum, query, books, selectedBook, filename, filePath, error_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    rows = readCSV(csvPath);
                    totalBooks = rows.length;
                    maxDownloads = config.maxDownloads;
                    console.log("Found ".concat(totalBooks, " books in CSV"));
                    if (maxDownloads) {
                        console.log("Download limit: ".concat(maxDownloads, " books\n"));
                    }
                    else {
                        console.log('No download limit set\n');
                    }
                    successCount = 0;
                    failCount = 0;
                    skippedCount = 0;
                    i = 0;
                    _a.label = 1;
                case 1:
                    if (!(i < rows.length)) return [3 /*break*/, 9];
                    row = rows[i];
                    bookNum = i + 1;
                    // Skip if already downloaded
                    if (row.status === 'downloaded') {
                        console.log("[".concat(bookNum, "/").concat(totalBooks, "] Skipping \"").concat(row.title, "\" by ").concat(row.author, " (already downloaded)"));
                        skippedCount++;
                        return [3 /*break*/, 8];
                    }
                    // Check if we've reached the download limit
                    if (maxDownloads && successCount >= maxDownloads) {
                        console.log("\nReached download limit of ".concat(maxDownloads, " books. Stopping."));
                        return [3 /*break*/, 9];
                    }
                    console.log("[".concat(bookNum, "/").concat(totalBooks, "] Processing: \"").concat(row.title, "\" by ").concat(row.author));
                    _a.label = 2;
                case 2:
                    _a.trys.push([2, 5, , 6]);
                    query = "".concat(row.author, " ").concat(row.title);
                    return [4 /*yield*/, findBook(query)];
                case 3:
                    books = _a.sent();
                    if (books.length === 0) {
                        console.log("  \u274C No results found\n");
                        updateCSVStatus(csvPath, i, 'failed');
                        failCount++;
                        return [3 /*break*/, 8];
                    }
                    selectedBook = filterBooks(books, config);
                    if (!selectedBook) {
                        console.log("  \u274C No matching books found after filtering\n");
                        updateCSVStatus(csvPath, i, 'failed');
                        failCount++;
                        return [3 /*break*/, 8];
                    }
                    console.log("  \uD83D\uDCDA Found: ".concat(selectedBook.format, " (").concat(selectedBook.size, ")"));
                    // Download the book
                    return [4 /*yield*/, downloadBook(selectedBook, config.secretKey, config.outputFolder)];
                case 4:
                    // Download the book
                    _a.sent();
                    filename = "".concat(selectedBook.title, ".").concat(selectedBook.format);
                    filename = filename.replace(/\//g, '');
                    filePath = path.join(config.outputFolder, filename);
                    if (verifyDownload(filePath)) {
                        console.log("  \u2705 Downloaded and verified successfully\n");
                        updateCSVStatus(csvPath, i, 'downloaded');
                        successCount++;
                    }
                    else {
                        console.log("  \u274C Download verification failed\n");
                        updateCSVStatus(csvPath, i, 'failed');
                        failCount++;
                    }
                    return [3 /*break*/, 6];
                case 5:
                    error_3 = _a.sent();
                    // Handle rate limiting
                    if (error_3 instanceof RateLimitError) {
                        console.log("\n".concat('='.repeat(50)));
                        console.log("\u26A0\uFE0F  RATE LIMIT EXCEEDED (429)");
                        console.log("Anna's Archive has rate limited this application.");
                        if (error_3.retryAfter) {
                            console.log("Retry after: ".concat(error_3.retryAfter, " seconds"));
                        }
                        console.log("\nStopping downloads. Summary:");
                        console.log("  \u2705 ".concat(successCount, " succeeded"));
                        console.log("  \u274C ".concat(failCount, " failed"));
                        console.log("  \u23ED\uFE0F  ".concat(skippedCount, " skipped"));
                        console.log("".concat('='.repeat(50)));
                        process.exit(0);
                    }
                    console.log("  \u274C Error: ".concat(error_3, "\n"));
                    updateCSVStatus(csvPath, i, 'failed');
                    failCount++;
                    return [3 /*break*/, 6];
                case 6:
                    if (!(i < rows.length - 1)) return [3 /*break*/, 8];
                    return [4 /*yield*/, new Promise(function (resolve) { return setTimeout(resolve, 1000); })];
                case 7:
                    _a.sent();
                    _a.label = 8;
                case 8:
                    i++;
                    return [3 /*break*/, 1];
                case 9:
                    console.log('='.repeat(50));
                    console.log("Download complete:");
                    console.log("  \u2705 ".concat(successCount, " succeeded"));
                    console.log("  \u274C ".concat(failCount, " failed"));
                    console.log("  \u23ED\uFE0F  ".concat(skippedCount, " skipped"));
                    console.log('='.repeat(50));
                    return [2 /*return*/];
            }
        });
    });
}
/**
 * Main entry point
 */
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var args, csvPath, config, error_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    args = process.argv.slice(2);
                    if (args.length === 0) {
                        console.error('Usage: node main.ts <csv-file-path>');
                        console.error('\nEnvironment variables:');
                        console.error('  ANNAS_SECRET_KEY (required) - Your Anna\'s Archive secret key');
                        console.error('  OUTPUT_FOLDER (optional) - Download destination (default: ./downloads)');
                        console.error('  PREFERRED_FORMAT (optional) - Preferred format (e.g., pdf, epub)');
                        console.error('  PREFERRED_LANGUAGE (optional) - Preferred language (e.g., English)');
                        process.exit(1);
                    }
                    csvPath = args[0];
                    if (!fs.existsSync(csvPath)) {
                        console.error("Error: CSV file not found: ".concat(csvPath));
                        process.exit(1);
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    config = loadConfig();
                    return [4 /*yield*/, processCSV(csvPath, config)];
                case 2:
                    _a.sent();
                    return [3 /*break*/, 4];
                case 3:
                    error_4 = _a.sent();
                    console.error("Error: ".concat(error_4));
                    process.exit(1);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// Run main function if this is the entry point
if (require.main === module) {
    main();
}
