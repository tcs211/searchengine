const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xml2js = require('xml2js');
const natural = require('natural');
const http = require('http');
const https = require('https');

const app = express();
const morgan = require("morgan");
const moment = require("moment");


// read arguments
var port = parseInt(process.argv[2]) || 80;


// Set up EJS as the view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));



// Serve static files from the 'public' directory
app.use(express.static('public'));


const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/documents');
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

morgan.token("date", function () {
    return moment().format("YYYY/MM/DD HH:mm:ss");
  });
  app.use(morgan("combined"));

// Custom index structure
let index = {
    invertedIndex: {},
    documentStore: {}
};

const DB_FILE = 'local_database.json';

// Porter Stemmer
const porterStemmer = natural.PorterStemmer;

// Stop words
const stopwords = new Set(natural.stopwords);

// Load existing index from file
function loadIndex() {
    try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        // if the file is empty, initialize the index
        if (data.length == 0) {
            index = { invertedIndex: {}, documentStore: {} };
            return;
        }
        index = JSON.parse(data);
        if (!index.invertedIndex) index.invertedIndex = {};
        if (!index.documentStore) index.documentStore = {};
        console.log('Loaded existing index from file');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('No existing index found, starting with an empty index');
            index = { invertedIndex: {}, documentStore: {} };
        } else {
            console.error('Error loading index:', error);
        }
    }
}

// Load existing index on startup
loadIndex();

// Save index to file
function saveIndex() {
    try {
        const serializedIndex = JSON.stringify(index);
        fs.writeFileSync(DB_FILE, serializedIndex, 'utf8');
        console.log('Index saved to file');
    } catch (error) {
        console.error('Error saving index:', error);
    }
}

// Tokenize and stem words
function tokenizeAndStem(text) {
    const tokenizer = new natural.WordTokenizer();
    return tokenizer.tokenize(text.toLowerCase())
        .filter(token => !stopwords.has(token))
        .map(token => porterStemmer.stem(token));
}

// Improved sentence counting function
function countSentences(text) {
    const abbreviations = ['Mr.', 'Mrs.', 'Dr.', 'Ms.', 'Prof.', 'Rev.', 'Gen.', 'Sen.', 'Rep.', 'St.', 'etc.', 'e.g.', 'i.e.'];
    
    abbreviations.forEach(abbr => {
        text = text.replace(new RegExp(`\\b${abbr}`, 'g'), abbr.replace('.', '##'));
    });

    const sentences = text.split(/[.!?]+/).filter(sentence => sentence.trim().length > 0);

    return sentences.map(sentence => {
        abbreviations.forEach(abbr => {
            sentence = sentence.replace(new RegExp(`\\b${abbr.replace('.', '##')}`, 'g'), abbr);
        });
        return sentence;
    }).length;
}

// File processing function
async function processFile(file) {
    if (!file || !file.path) {
        throw new Error('Invalid file object');
    }

    const filePath = path.join(__dirname, file.path);
    const fileContent = fs.readFileSync(filePath, 'utf8');
    let content = '';

    // Ensure we have a valid filename
    const filename = file.originalname || path.basename(file.path);

    if (file.mimetype.indexOf('json') >= 0) {
        try {
            const jsonContent = JSON.parse(fileContent);
            const textFields = [];
            const extractText = (obj) => {
                for (const key in obj) {
                    if (typeof obj[key] === 'string') {
                        textFields.push(obj[key]);
                    } else if (Array.isArray(obj[key])) {
                        obj[key].forEach(item => {
                            if (typeof item === 'string') {
                                textFields.push(item);
                            } else if (typeof item === 'object') {
                                extractText(item);
                            }
                        });
                    } else if (typeof obj[key] === 'object') {
                        extractText(obj[key]);
                    }
                }
            };
            extractText(jsonContent);
            content = textFields.join(' ');

            // console.log('Extracted text from JSON:', content)
        } catch (error) {
            console.error('Error parsing JSON:', error);
            content = fileContent; // Fallback to treating it as plain text
        }
    } else if (file.mimetype.indexOf('xml') >= 0) {
        try {
            const result = await new Promise((resolve, reject) => {
                xml2js.parseString(fileContent, (err, result) => {
                    if (err) reject(err);
                    else resolve(result);
                });
            });
    
            // Function to recursively extract text from XML structure
            const extractTextFromXML = (obj) => {
                let text = '';
                for (let key in obj) {
                    if (typeof obj[key] === 'string') {
                        text += obj[key] + ' ';
                    } else if (Array.isArray(obj[key])) {
                        obj[key].forEach(item => {
                            if (typeof item === 'string') {
                                text += item + ' ';
                            } else if (typeof item === 'object') {
                                text += extractTextFromXML(item) + ' ';
                            }
                        });
                    } else if (typeof obj[key] === 'object') {
                        text += extractTextFromXML(obj[key]) + ' ';
                    }
                }
                return text.trim();
            };
    
            content = extractTextFromXML(result);
            // console.log('Extracted text from XML:', content)
        } catch (error) {
            console.error('Error parsing XML:', error);
            content = fileContent; // Fallback to treating it as plain text
        }
    } else {
        content = fileContent;
    }

    const tokenizer = new natural.WordTokenizer();
    const tokens = tokenizer.tokenize(content.toLowerCase());
    const charCount = content.length;
    const wordCount = tokens.length;
    const sentenceCount = countSentences(content);

    const stemToWord = {};
    const stems = tokens.map(token => {
        if (!stopwords.has(token)) {
            // console.log(token, '=>', porterStemmer.stem(token));
            const stem = porterStemmer.stem(token);
            stemToWord[stem] = stemToWord[stem] || token;
            return stem;
        }
        return null;
    }).filter(stem => stem !== null);

    // print the stems
    // console.log(stems);

    const keywordFrequency = stems.reduce((acc, stem) => {
        acc[stem] = (acc[stem] || 0) + 1;
        return acc;
    }, {});

    const wordFrequency = Object.entries(keywordFrequency).reduce((acc, [stem, freq]) => {
        acc[stemToWord[stem]] = freq;
        return acc;
    }, {});

    // Add to inverted index
    stems.forEach((stem, position) => {
        if (!index.invertedIndex[stem]) {
            index.invertedIndex[stem] = {};
        }
        if (!index.invertedIndex[stem][filename]) {
            index.invertedIndex[stem][filename] = [];
        }
        index.invertedIndex[stem][filename].push(position);
    });

    // Add to document store
    index.documentStore[filename] = {
        content: content,
        charCount: charCount,
        wordCount: wordCount,
        sentenceCount: sentenceCount,
        keywordFrequency: wordFrequency,
        stemToWord: stemToWord
    };

    // Save updated index
    saveIndex();


    return {
        filename: filename,
        charCount,
        wordCount,
        sentenceCount,
        keywordFrequency: Object.entries(wordFrequency)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .reduce((obj, [key, value]) => {
                obj[key] = value;
                return obj;
            }, {})
    };
}

// Custom search function with phrase support and detailed results
function search(query) {
    const phrases = query.match(/"([^"]+)"/g) || [];
    const singleTerms = query.replace(/"([^"]+)"/g, '').trim().split(/\s+/);
    
    const results = {};

    // Process single terms
    singleTerms.forEach(term => {
        const stemmedTerm = porterStemmer.stem(term.toLowerCase());
        if (!stopwords.has(stemmedTerm) && index.invertedIndex[stemmedTerm]) {
            Object.keys(index.invertedIndex[stemmedTerm]).forEach(docId => {
                if (!results[docId]) {
                    results[docId] = { score: 0, matches: {} };
                }
                results[docId].score += index.invertedIndex[stemmedTerm][docId].length;
                results[docId].matches[term] = index.invertedIndex[stemmedTerm][docId].length;
            });
        }
    });

    // Process phrases
    phrases.forEach(phrase => {
        const phraseTerms = tokenizeAndStem(phrase.replace(/"/g, ''));
        Object.keys(index.documentStore).forEach(docId => {
            const docContent = index.documentStore[docId].content.toLowerCase();
            const phraseRegex = new RegExp(phraseTerms.map(term => `\\b${term}\\b`).join('\\s+'), 'g');
            const matches = (docContent.match(phraseRegex) || []).length;
            if (matches > 0) {
                if (!results[docId]) {
                    results[docId] = { score: 0, matches: {} };
                }
                results[docId].score += matches * phraseTerms.length; // Boost phrase matches
                results[docId].matches[phrase] = matches;
            }
        });
    });

    return Object.entries(results)
        .map(([docId, { score, matches }]) => {
            const docInfo = index.documentStore[docId];
            return {
                filename: docId,
                score: score,
                matches: matches,
                charCount: docInfo.charCount,
                wordCount: docInfo.wordCount,
                sentenceCount: docInfo.sentenceCount,
                keywordFrequency: Object.entries(docInfo.keywordFrequency)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 10)
                    .reduce((obj, [key, value]) => {
                        obj[key] = value;
                        return obj;
                    }, {}),
                preview: docInfo.content.substring(0, 200) + '...'
            };
        })
        .sort((a, b) => b.score - a.score);
}

// Home page route
app.get('/', (req, res) => {
    res.render('index');
});

// File upload endpoint
app.post('/upload', upload.single('file'), async (req, res) => {
    try {
        console.log('Uploaded file:', req.file);
        const fileInfo = await processFile(req.file);
    
        
        res.json(fileInfo);

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Search endpoint
app.get('/search', (req, res) => {
    const query = req.query.q;
    if (!query) {
        return res.json({ results: [] });
    }
    const results = search(query);
    res.json({ results });
});


// Start the server
if(port == 80){
    var key = "";
    var cert = "";
    try {
        const key = fs.readFileSync(`C:\\Certbot\\live\\to-ai.net-0001\\privkey.pem`);
        const cert = fs.readFileSync(`C:\\Certbot\\live\\to-ai.net-0001\\fullchain.pem`);
        var options = {
            key: key,
            cert: cert,
            secureProtocol: 'TLSv1_2_method',
            ciphers: [
                "ECDHE-RSA-AES128-GCM-SHA256",
                "ECDHE-ECDSA-AES128-GCM-SHA256",
                "ECDHE-RSA-AES256-GCM-SHA384",
                "ECDHE-ECDSA-AES256-GCM-SHA384",
                "DHE-RSA-AES128-GCM-SHA256",
            ].join(':'),
        }
        
        https.createServer(options, app).listen(443, function () {
        console.log("https listening on port 443");
        });
      
    } catch(err) {
      console.log(err);
    }
   
}

// http server
http.createServer(app).listen(port, function () {
  console.log("Express server listening on port " + port);
});