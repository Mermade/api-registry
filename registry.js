#!/usr/bin/env node
// @ts-check

'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const url = require('url');
const util = require('util');

const deepmerge = require('deepmerge');
const fetch = require('fetch-filecache-for-crawling');
const mkdirp = require('mkdirp');
const pd = require('parse-domain');
const s2o = require('swagger2openapi');
const resolver = require('oas-resolver');
const validator = require('oas-validator');
const yaml = require('yaml');
const removeMarkdown = require('remove-markdown');
const j2x = require('jgexml/json2xml.js');
const shields = require('badge-maker').makeBadge;
const liquid = require('liquid');
const semver = require('semver');

const ng = require('./index.js');

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const logoPath = path.resolve('.','deploy','v2','cache','logo');
const logoCache = path.resolve('.','metadata','logo.cache');
const mainCache = path.resolve('.','metadata','main.cache');

const liquidEngine = new liquid.Engine();

const argv = require('tiny-opts-parser')(process.argv);
if (argv.q) argv.quiet = argv.q;
if (argv.s) argv.service = argv.s;
if (argv.h) argv.host = argv.h;
if (argv.l) argv.logo = argv.l;
if (argv.t) argv.twitter = argv.t;
if (argv.c) argv.categories = argv.c;
if (argv.f) argv.force = argv.f;
if (argv.d) argv.debug = argv.d;
if (argv.i) argv.issue = argv.i;
if (argv.u) argv.unofficial = argv.u;

let oasCache = {};
const resOpt = { resolve: true, fatal: true, verbose: false, cache: oasCache, fetch:fetch, fetchOptions: { cacheFolder: mainCache, refresh: 'default' } };
const valOpt = { patch: true, warnOnly: true, anchors: true, laxurls: true, laxDefaults: true, validateSchema: 'never', resolve: false, cache: oasCache, fetch:fetch, fetchOptions: { cacheFolder: mainCache, refresh: 'default' } };
const dayMs = 24 * 60 * 60 * 1000; // hours*minutes*seconds*milliseconds
let htmlTemplate;

//Disable check of SSL certificates
//process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

function agent(url) {
  if (url.startsWith('https')) return httpsAgent;
  if (url.startsWith('http')) return httpAgent;
  return undefined;
}

function getProvider(u) {
  let {subDomains, domain, topLevelDomains} = pd.parseDomain(
    pd.fromUrl(u)
  );
  if (!domain) {
    const up = url.parse(u);
    domain = up.host;
  }
  if (typeof domain === 'string') domain = domain.replace('api.','');
  return domain+(topLevelDomains ? '.'+topLevelDomains.join('.') : '');
}

async function validateObj(o,s,candidate,source) {
  valOpt.text = s;
  let result = { valid: false };
  try {
    process.stdout.write('R');
    await resolver.resolve(o,source,resOpt);
    o = resOpt.openapi;
    if (o.swagger && o.swagger == '2.0') {
      process.stdout.write('C');
      await s2o.convertObj(o, valOpt);
      o = valOpt.openapi; //? working?
    }
    else {
      // TODO
    }
    process.stdout.write('V');
    if (o.openapi) {
      await validator.validate(o, valOpt);
      result = valOpt;
    }
    else if (o.asyncapi) {
      result.valid = true; // TODO
    }
    if (!result.valid) throw new Error('Validation failure');
  }
  catch (ex) {
    console.log();
    console.warn(ng.colour.red+ex.message+ng.colour.normal);
    if (argv.debug) console.warn(ex);
    let context;
    if (valOpt.context) {
      context = valOpt.context.pop();
      console.warn(ng.colour.red+context+ng.colour.normal);
    }
    ng.fail(candidate,null,ex,context);
  }
  console.log('',result.valid ? ng.colour.green+'✔' : ng.colour.red+'✗',ng.colour.normal);
  candidate.md.valid = result.valid;
  return result.valid;
}

async function fix(candidate, o) {
  // TODO use jmespath queries to fix up stuff
}

async function retrieve(u) {
  let response = { status: 599, ok: false };
  let s;
  if (u.startsWith('http')) {
    process.stdout.write('F');
    response = await fetch(u, {timeout:1000, agent:agent(u), logToConsole:false, cacheFolder: mainCache, refresh: 'default'});
    if (response.ok) {
      s = await response.text();
    }
  }
  else if (u.startsWith('file')) {
    const filename = url.fileURLToPath(u);
    s = fs.readFileSync(filename,'utf8');
    response.status = 200;
    response.ok = true;
  }
  else {
    s = fs.readFileSync(u,'utf8');
    response.status = 200;
    response.ok = true;
  }
  return { response, text:s }
}

const commands = {
  populate: async function(candidate) {
    console.log('pop');
    return true;
  },
  git: async function(candidate) {
    const dates = ng.exec(`git log --format=%aD --follow -- '${candidate.md.filename}'`).toString().split('\n');
    candidate.md.added = new Date(dates[dates.length-2]);
    candidate.md.updated = new Date(dates[0]);
    console.log('git');
    return true;
  },
  urls: async function(candidate) {
    console.log();
    console.log(ng.colour.yellow+candidate.md.source.url+ng.colour.normal);
  },
  rewrite: async function(candidate) {
    let s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    fs.writeFileSync(candidate.md.filename,yaml.stringify(o),'utf8');
    console.log('rw');
  },
  purge: async function(candidate) {
    if (!fs.existsSync(candidate.md.filename)) {
      console.log(ng.colour.yellow+'␡'+ng.colour.normal);
      delete candidate.parent[candidate.version];
    }
    else {
      console.log();
    }
  },
  paths: async function(candidate) {
    try {
      let s = fs.readFileSync(candidate.md.filename,'utf8');
      const o = yaml.parse(s);
      candidate.md.paths = Object.keys(o.paths).length;
      if (candidate.md.paths === 0) {
        fs.unlinkSync(candidate.md.filename);
        delete candidate.parent[candidate.version];
      }
      console.log(ng.colour.green+'p:'+candidate.md.paths,ng.colour.normal);
    }
    catch (ex) {
      console.log(ng.colour.red+ex.message,ng.colour.normal);
      ng.fail(candidate,null,ex,'paths');
    }
  },
  cache: async function(candidate) {
    let s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    const origin = o.info['x-origin'];
    const source = origin.pop();

    source.url = source.url.replace('https://raw.githubusercontent.com/NYTimes/public_api_specs/master','../cache/nytimes.com/public_api_specs-master');
    source.url = source.url.replace('https://raw.githubusercontent.com/Azure/azure-rest-api-specs/master','../cache/azure.com/azure-rest-api-specs-master');
    source.url = source.url.replace('file://localhost/','');

    origin.push(source);
    fs.writeFileSync(candidate.md.filename,yaml.stringify(o),'utf8');
    console.log('cache');
  },
  deploy: async function(candidate) {
    let s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    const defaultLogo = 'https://apis.guru/assets/images/no-logo.svg';
    let origLogo = defaultLogo;
    if ((o.info['x-logo']) && (o.info['x-logo'].url)) {
      origLogo = o.info['x-logo'].url;
    }
    const logoName = origLogo.split('://').join('_').split('/').join('_').split('?')[0];
    const logoFull = path.join(logoPath,logoName);
    let colour = ng.colour.green;
    if (!fs.existsSync(logoFull)) { // if we have not deployed this logo yet
      let response;
      try {
        const res = await fetch(origLogo, {timeout:1000, cacheFolder: logoCache, refresh: 'never'}); // TODO removed agent for now because of scheme changes on redirects
        response = await res.buffer();
      }
      catch (ex) {
        colour = ng.colour.red;
        console.warn(ng.colour.red+ex.message+ng.colour.normal);
        if (argv.debug) console.warn(ex);
        const res = await fetch(defaultLogo, {timeout:1000, agent:agent(defaultLogo), cacheFolder: logoCache, refresh: 'never'});
        response = await res.buffer();
      }
      if (response) {
        fs.writeFileSync(logoFull,response);
      }
    }
    process.stdout.write(colour+'📷 '+ng.colour.normal);

    if (!o.info['x-logo']) o.info['x-logo'] = {};
    o.info['x-logo'].url = 'https://api.apis.guru/v2/cache/logo/'+logoName;

    s = yaml.stringify(o);
    const j = JSON.stringify(o,null,2);
    const filename = candidate.md.openapi.startsWith('3.') ? 'openapi.' : 'swagger.';
    let filepath = path.resolve('.','deploy','v2','specs');
    filepath = path.join(filepath,candidate.provider,candidate.service,candidate.version);
    await mkdirp(filepath);
    fs.writeFileSync(path.join(filepath,filename+'yaml'),s,'utf8');
    fs.writeFileSync(path.join(filepath,filename+'json'),j,'utf8');
    console.log(ng.colour.green+'✔'+ng.colour.normal);
    return true;
  },
  docs: async function(candidate) {
    let docpath = path.resolve('.','deploy','docs',candidate.provider,candidate.service);
    await mkdirp(docpath);
    docpath += '/'+candidate.version+'.html';
    const html = await htmlTemplate.render({ url: getApiUrl(candidate,'.json'), title: candidate.md.filename } );
    fs.writeFileSync(docpath,html,'utf8');
    console.log(ng.colour.green+'🗎'+ng.colour.normal);
  },
  validate: async function(candidate) {
    const s = fs.readFileSync(candidate.md.filename,'utf8');
    const o = yaml.parse(s);
    return await validateObj(o,s,candidate,candidate.md.filename);
  },
  ci: async function(candidate) {
    const diff = Math.round(Math.abs((ng.now - new Date(candidate.md.updated)) / dayMs));
    if (diff <= 1.1) {
      const s = fs.readFileSync(candidate.md.filename,'utf8');
      const o = yaml.parse(s);
      return await validateObj(o,s,candidate,candidate.md.filename);
    }
    else {
      console.log(ng.colour.yellow+'🕓'+ng.colour.normal);
    }
  },
  add: async function(u, metadata) {
    process.stdout.write(u+' ');
    try {
      const result = await retrieve(u);
      if (result.response.ok) {
        let o = yaml.parse(result.text);
        const org = o;
        const candidate = { md: { source: { url: u }, valid: false } };
        const valid = await validateObj(o,result.text,candidate,candidate.md.source.url);
        if (valid || argv.force) {
          if (valOpt.patches > 0) {
            o = valOpt.openapi;
          }
          let ou = u;
          if (o.servers) {
            if (argv.host) {
              let url = argv.host;
              if (!url.startsWith('http')) {
                url = 'http://'+argv.host; // not https as likely a .local placeholder
              }
              o.servers.unshift({ url: url });
            }
            ou = o.servers[0].url;
          }
          if (o.host) {
            if (argv.host) o.host = argv.host;
            ou = o.host;
          }

          if (argv.logo) {
            if (!o.info['x-logo']) {
              o.info['x-logo'] = {};
            }
            o.info['x-logo'].url = argv.logo;
          }
          // TODO if there is a logo.url try and fetch/cache it

          const provider = getProvider(ou);
          const service = argv.service || '';

          if (!metadata[provider]) {
            metadata[provider] = { driver: 'url', apis: {} };
          }
          if (!metadata[provider].apis[service]) {
            metadata[provider].apis[service] = {};
          }
          candidate.md.added = ng.now;
          candidate.md.updated = ng.now;
          candidate.md.history = [];
          if (org.openapi) {
            candidate.md.name = 'openapi.yaml';
            candidate.md.source.format = 'openapi';
            candidate.md.source.version = semver.major(org.openapi)+'.'+semver.minor(org.openapi);
            candidate.md.openapi = org.openapi;
          }
          else if (org.swagger) {
            candidate.md.name = 'swagger.yaml';
            candidate.md.source.format = 'swagger';
            candidate.md.source.version = org.swagger;
            candidate.md.openapi = o.openapi ? o.openapi : o.swagger;
          }
          else if (org.asyncapi) {
            candidate.md.name = 'asyncapi.yaml';
            candidate.md.source.format = 'asyncapi';
            candidate.md.source.version = semver.major(org.asyncapi)+'.'+semver.minor(org.asyncapi);
            candidate.md.asyncapi = org.asyncapi;
          }
          if (o.info && o.info.version === '') {
            o.info.version = '1.0.0';
          }
          metadata[provider].apis[service][o.info.version] = candidate.md;

          const filepath = path.resolve('.','APIs',provider,service,o.info.version);
          await mkdirp(filepath);
          const filename = path.resolve(filepath,candidate.md.name);
          candidate.md.filename = path.relative('.',filename);

          o.info['x-providerName'] = provider;
          if (service) {
            o.info['x-serviceName'] = service;
          }
          if (argv.unofficial) {
            o.info['x-unofficialSpec'] = true;
          }
          if (!o.info['x-origin']) {
            o.info['x-origin'] = [];
          }
          o.info['x-origin'].push(candidate.md.source);

          const patch = {};
          if (argv.categories) {
            const categories = argv.categories.split(',');
            o.info['x-apisguru-categories'] = categories;
            if (!patch.info) patch.info = {};
            patch.info['x-apisguru-categories'] = categories;
          }
          if (Object.keys(patch).length) {
            candidate.md.patch = patch;
          }

          const content = yaml.stringify(ng.sortJson(o));
          candidate.md.hash = ng.sha256(content);
          candidate.md.paths = Object.keys(o.paths || o.topics).length; // TODO rename paths property
          fs.writeFileSync(filename,content,'utf8');
          console.log('Wrote new',provider,service||'-',o.info.version,'in OpenAPI',candidate.md.openapi,valid ? ng.colour.green+'✔' : ng.colour.red+'✗',ng.colour.normal);
        }
      }
      else {
        console.warn(ng.colour.red,result.response.status,ng.colour.normal);
      }
    }
    catch (ex) {
      console.warn(ng.colour.red+ex.message+ng.colour.normal);
      if (argv.debug) console.warn(ex);
    }
  },
  update: async function(candidate) {
    const u = candidate.md.source.url;
    if (!u) throw new Error('No url');
    if (candidate.driver === 'external') return true;
    // TODO github, google, apisjson etc
    try {
      const result = await retrieve(u);
      let o = {};
      let autoUpgrade = false;
      if (result && result.response.ok) {
        const s = result.text;
        o = yaml.parse(s);
        const valid = await validateObj(o,s,candidate,candidate.md.source.url);
        if (valid) {
          if (o.info && o.info.version === '') {
            o.info.version = '1.0.0';
          }

          // TODO if there is a logo.url try and fetch/cache it

          if ((valOpt.patches > 0) || (candidate.md.autoUpgrade)) {
            // passed validation as OAS 3 but only by patching the source
            // therefore the original OAS 2 document might not be valid as-is
            o = valOpt.openapi;
            autoUpgrade = true;
          }

          let openapiVer = (o.openapi ? o.openapi : o.swagger);
          if ((o.info && (o.info.version !== candidate.version)) || (openapiVer !== candidate.md.openapi)) {
            console.log('  Updated to',o.info.version,'in OpenAPI',openapiVer);
            if (o.info.version !== candidate.version) {
              candidate.parent[o.info.version] = candidate.parent[candidate.version];
              delete candidate.parent[candidate.version];
            }
            const ofname = candidate.md.filename;
            candidate.md.filename = candidate.md.filename.replace(candidate.version,o.info.version);
            if (o.openapi) {
              candidate.md.filename = candidate.md.filename.replace('swagger.yaml','openapi.yaml');
              candidate.md.name = 'openapi.yaml';
              candidate.md.source.format = 'openapi';
              candidate.md.source.version = semver.major(o.openapi)+'.'+semver.minor(o.openapi);
            }
            const pathname = path.dirname(candidate.md.filename);
            mkdirp.sync(pathname);
            ng.exec('mv '+ofname+' '+candidate.md.filename);
          }
          if (candidate.md.patch) o = deepmerge(o,candidate.md.patch);
          delete o.info.logo; // TODO nytimes hack (masked by conv stage)
          if (o.info['x-apisguru-categories']) {
            o.info['x-apisguru-categories'] = Array.from(new Set(o.info['x-apisguru-categories']));
          }
          o.info['x-providerName'] = candidate.provider;
          const origin = ng.clone(candidate.md.history);
          origin.push(candidate.md.source);
          o.info['x-origin'] = origin;
          if (candidate.service) o.info['x-serviceName'] = candidate.service;
          if (typeof candidate.md.preferred === 'boolean') o.info['x-preferred'] = candidate.md.preferred;
          const content = yaml.stringify(ng.sortJson(o));
          fs.writeFile(candidate.md.filename,content,'utf8',function(err){
            if (err) console.warn(err);
          });
          const newHash = ng.sha256(content);
          if (candidate.md.hash !== newHash) {
            candidate.md.hash = newHash;
            candidate.md.updated = ng.now;
          }
          candidate.md.paths = Object.keys(o.paths||o.topics).length;
          delete candidate.md.statusCode;
        }
        else { // if not valid
          return false;
        }
      }
      else { // if not status 200 OK
        ng.fail(candidate,result.response.status);
        console.log(ng.colour.red,result.response.status,ng.colour.normal);
        return false;
      }
    }
    catch (ex) {
      if (ex.timings) delete ex.timings;
      console.log();
      console.warn(ng.colour.red+ex.message,ex.response ? ex.response.statusCode : '',ng.colour.normal);
      if (argv.debug || !ex.message) console.warn(ex);
      let r = ex.response;
      if (r) {
        candidate.md.statusCode = r.status;
        if (r.headers) {
          candidate.md.mediatype = r.headers.get('content-type');
        }
      }
      ng.fail(candidate,r ? r.status : undefined, ex, candidate.md.mediatype);
      return false;
    }
    return true;
  }
};

function rssFeed(data) {
  let feed = {};
  let rss = {};

  let d = ng.now;

  console.log('RSS Feed...');

  rss['@version'] = '2.0';
  rss["@xmlns:atom"] = 'http://www.w3.org/2005/Atom';
  rss.channel = {};
  rss.channel.title = 'APIs.guru OpenAPI directory RSS feed';
  rss.channel.link = 'https://api.apis.guru/v2/list.rss';
  rss.channel["atom:link"] = {};
  rss.channel["atom:link"]["@rel"] = 'self';
  rss.channel["atom:link"]["@href"] = rss.channel.link;
  rss.channel["atom:link"]["@type"] = 'application/rss+xml';
  rss.channel.description = 'APIs.guru OpenAPI directory RSS feed';
  rss.channel.webMaster = 'mike.ralphson@gmail.com (Mike Ralphson)';
  rss.channel.pubDate = ng.now.toUTCString();
  rss.channel.generator = 'openapi-directory https://github.com/apis-guru/openapi-directory';
  rss.channel.item = [];

  for (let api in data) {

      let p = data[api].versions[data[api].preferred];
      if (p && p.info) {
        let i = {};
        i.title = p.info.title;
        i.link = p.info["x-origin"][0].url;
        i.description = removeMarkdown(p.info.description ? p.info.description.trim().split('\n')[0] : p.info.title);
        i.category = 'APIs';
        i.guid = {};
        i.guid["@isPermaLink"] = 'false';
        i.guid[""] = api;
        i.pubDate = new Date(p.updated).toUTCString();

        if (p.info["x-logo"]) {
          i.enclosure = {};
          i.enclosure["@url"] = p.info["x-logo"].url;
          i.enclosure["@length"] = 15026;
          i.enclosure["@type"] = 'image/jpeg';
          if (typeof i.enclosure["@url"] === 'string') {
            let tmp = i.enclosure["@url"].toLowerCase();
            if (tmp.indexOf('.png')>=0) i.enclosure["@type"] = 'image/png';
            if (tmp.indexOf('.svg')>=0) i.enclosure["@type"] = 'image/svg+xml';
          }
          else console.warn(api,i.enclosure["@url"]);
        }

        rss.channel.item.push(i);
      }
  }

  feed.rss = rss;
  return j2x.getXml(feed,'@','',2);
}

function getApiUrl(candidate, ext) {
  let result = 'https://api.apis.guru/v2/specs/'+candidate.provider;
  if (candidate.service) result += '/' + candidate.service;
  result += '/' + candidate.version + '/' + (candidate.md.openapi.startsWith('3.') ? 'openapi' : 'swagger') + ext;
  return result;
}

function badges(metrics) {
  const badgepath = path.resolve('.','deploy','badges');
  console.log('Badges...');
  mkdirp.sync(badgepath);
  const badges = [
    { label: 'APIs in collection', name: 'apis_in_collection.svg', prop: 'numAPIs', color: 'orange' },
    { label: 'Endpoints', name: 'endpoints.svg', prop: 'numEndpoints', color: 'red' },
    { label: 'OpenAPI Specs', name: 'openapi_specs.svg', prop: 'numSpecs', color: 'yellow' },
    { label: '🐝 Tested on', name: 'tested_on.svg', prop: 'numSpecs', color: 'green' }
  ];
  for (let badge of badges) {
     const format = { label: badge.label, message: metrics[badge.prop].toString(), color: badge.color };
     // TODO logo when https://github.com/badges/shields/issues/4947 done
     const svg = shields(format);
     fs.writeFileSync(badgepath+'/'+badge.name,svg,'utf8');
  }
}

const startUp = {
  docs: async function(candidates) {
    htmlTemplate = await liquidEngine.parse(fs.readFileSync(path.resolve(__dirname,'templates','redoc.html'),'utf8'));
  }
};

const wrapUp = {
  deploy: async function(candidates) {
    let totalPaths = 0;
    const list = {};

    console.log('API list...');

    for (let candidate of candidates) {
      totalPaths += candidate.md.paths;
      let key = candidate.provider;
      if (candidate.service) key += ':'+candidate.service;
      if (!list.key) list[key] = { added: candidate.md.added, preferred: candidate.version, versions: {} };
      list[key].versions[candidate.version] = { added: candidate.md.added, info: candidate.info, updated: candidate.md.updated, swaggerUrl: getApiUrl(candidate, '.json'), swaggerYamlUrl: getApiUrl(candidate,'.yaml'), openapiVer: candidate.md.openapi };
      if (candidate.preferred) list[key].preferred = candidate.version;
    }
    const metrics = {
      numSpecs: candidates.length,
      numAPIs: Object.keys(list).length,
      numEndpoints: totalPaths
    };
    badges(metrics);
    fs.writeFileSync(path.resolve('.','deploy','v2','list.json'),JSON.stringify(list,null,2),'utf8');
    fs.writeFileSync(path.resolve('.','deploy','v2','metrics.json'),JSON.stringify(metrics,null,2),'utf8');
    const xml = rssFeed(list);
    fs.writeFileSync(path.resolve('.','deploy','v2','list.rss'),xml,'utf8');
    fs.writeFileSync(path.resolve('.','deploy','.nojekyll'),'','utf8');
    try {
      const indexHtml = fs.readFileSync(path.resolve('.','metadata','index.html'),'utf8');
      fs.writeFileSync(path.resolve('.','deploy','index.html'),indexHtml,'utf8');
    }
    catch (ex) {
      console.warn(ng.colour.red+ex.message+ng.colour.normal);
    }
  },
  docs: async function(candidates) {
    fs.writeFileSync(path.resolve('.','deploy','docs','index.html'),fs.readFileSync(path.resolve(__dirname,'templates','index.html'),'utf8'),'utf8');
  }
};

function analyseOpt(options) { // show size of each bucket in oas-kit options
  let result = {};
  for (let p in options) {
    let j = JSON.stringify(options[p]);
    result[p] = (typeof j === 'string' ? j.length : 0);
  }
  return result;
}

async function main(command, pathspec) {
  const metadata = ng.loadMetadata();

  if (command === 'add') {
    await commands[command](pathspec, metadata);
    ng.saveMetadata(command);
    return 1;
  }

  if (!argv.only) {
    const apis = await ng.gather(pathspec, command, argv.patch);
    console.log(Object.keys(apis).length,'API files read');
    ng.populateMetadata(apis, pathspec);
  }
  await ng.runDrivers(argv.only);
  const candidates = ng.getCandidates(argv.only);
  console.log(candidates.length,'candidates found');

  if (startUp[command]) {
    await startUp[command](candidates);
  }

  let count = 0;
  let oldProvider = '*';
  for (let candidate of candidates) {
    if (candidate.provider !== oldProvider) {
      oasCache = {};
      resOpt.cache = oasCache;
      valOpt.cache = oasCache;
      oldProvider = candidate.provider;
    }
    process.stdout.write(candidate.provider+' '+candidate.driver+' '+(candidate.service||'-')+' '+candidate.version+' ');
    await commands[command](candidate);
    //delete valOpt.cache[resOpt.source];

    //let voa = analyseOpt(valOpt);
    //fs.writeFileSync('./valopt'+count+'.json',JSON.stringify(voa,null,2),'utf8');
    count++;
  }

  if (wrapUp[command]) {
    await wrapUp[command](candidates);
  }

  ng.saveMetadata(command);
  return candidates.length;
}

process.exitCode = 0;

let command = argv._[2];
if (!command) {
  console.warn('Usage: registry {command}, where {command} is one of:');
  console.warn(Object.keys(commands));
  process.exit(0);
}
if (command === 'deploy') {
  mkdirp.sync(logoPath);
}
let pathspec = argv._[3];
if (!pathspec) pathspec = path.relative('.','APIs');

process.on('exit', function() {
  console.log('Exiting with',process.exitCode);
});

main(command, pathspec);

