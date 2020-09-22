const path = require('path')
const fs = require('fs-extra')
const slash = require('slash')
const crypto = require('crypto')
const mime = require('mime-types')
const { mapValues, trim, trimEnd } = require('lodash')
const tilde = require('expand-tilde');
const isDev = process.env.NODE_ENV === 'development'

class FilesystemSource {
  static defaultOptions () {
    return {
      baseDir: undefined,
      path: undefined,
      route: undefined,
      pathPrefix: undefined,
      index: ['index'],
      typeName: 'FileNode',
      refs: {}
    }
  }

  resolvePath(path){
    if (path && path.startsWith("~")){
      var home = tilde('~');
      return path.replace("~", home, 0)
      
    }
    return path;
  }

  constructor (api, options) {
    this.api = api
    this.options = options
    this.context = options.baseDir
      ? api.resolve(this.resolvePath(options.baseDir))
      : api.context
    this.refsCache = {}

    api.loadSource(async actions => {
      this.createCollections(actions)
      await this.createNodes(actions)
      if (isDev) this.watchFiles(actions)
    })
  }

  createCollections (actions) {
    const addCollection = actions.addCollection || actions.addContentType

    this.refs = this.normalizeRefs(this.options.refs)

    this.collection = addCollection({
      typeName: this.options.typeName,
      route: this.options.route
    })

    mapValues(this.refs, (ref, key) => {
      this.collection.addReference(key, ref.typeName)

      if (ref.create) {
        addCollection({
          typeName: ref.typeName,
          route: ref.route
        })
      }
    })
  }

  async createNodes (actions) {
    const glob = require('globby')

    const files = await glob(this.options.path, { cwd: this.context })

    await Promise.all(files.map(async file => {
      const options = await this.createNodeOptions(file, actions)
      const node = this.collection.addNode(options)

      this.createNodeRefs(node, actions)
    }))
  }

  createNodeRefs (node, actions) {
    for (const fieldName in this.refs) {
      const ref = this.refs[fieldName]

      if (node && node[fieldName] && ref.create) {
        const value = node[fieldName]
        const typeName = ref.typeName

        if (Array.isArray(value)) {
          value.forEach(value =>
            this.addRefNode(typeName, fieldName, value, actions)
          )
        } else {
          this.addRefNode(typeName, fieldName, value, actions)
        }
      }
    }
  }

  watchFiles (actions) {
    const chokidar = require('chokidar')

    const watcher = chokidar.watch(this.options.path, {
      cwd: this.context,
      ignoreInitial: true
    })

    watcher.on('add', async file => {
      const options = await this.createNodeOptions(slash(file), actions)
      const node = this.collection.addNode(options)

      this.createNodeRefs(node, actions)
    })

    watcher.on('unlink', file => {
      const absPath = path.join(this.context, slash(file))

      this.collection.removeNode({
        'internal.origin': absPath
      })
    })

    watcher.on('change', async file => {
      const options = await this.createNodeOptions(slash(file), actions)
      const node = this.collection.updateNode(options)

      this.createNodeRefs(node, actions)
    })
  }

  // helpers
  cleanMarkdownPage(page, dir){
    // remove parts between --- ---
    var lines = page.split("\n");
    
    var removeLine = false
    var to_remove = []
    for(var i=0; i < lines.length; i++) {
      var line = lines[i];
      if (line.startsWith("---") && !removeLine ){
        removeLine = true;
      }else if(line.startsWith("---") && removeLine){
        removeLine = false;
      }
      if (removeLine){
        to_remove.push(i)
      }

      // for images we needs to rewrite relative paths
      if (line.startsWith("![](./")){
        lines[i] = line.replace("![](./", "![](" + dir)
      }
    }

    for(var i = to_remove.length -1; i>=0; i--){
      lines.splice(to_remove[i], 1)
    }
    return lines.join("\n");
  }

  async macroSubstituion(content){
    /* 
     * includes
     *
     * !!!include:$reponame:$docname
     * !!!include:$orgname:$reponame:$docname
     * 
     */
      var lines = content.split("\n");
      for(var i=0; i < lines.length; i++) {
        var line = lines[i];
        if (line.startsWith("!!!include:")){
            var newLine = line.replace("!!!include:$", "");
            var parts = newLine.split(":$");
            var orgname = "github";
            var reponame;
            var docname;

            if (parts.length > 3 || parts.length < 2){
              console.log("failed to replace include macro (" + line + ")");
              continue;
            }

            if (parts.length == 3){
              orgname = parts[0];
              reponame = parts[1];
              docname = parts[2];
            }else if (parts.length == 2){
              reponame = parts[0];
              docname = parts[1].replace(".md", "");
            }
            var dir = this.context + orgname + "/" + reponame + "/"
            var path = dir + docname + ".md"
            await fs.readFile(path, 'utf8').then((val) => {content = content.replace(line, this.cleanMarkdownPage(val, dir))});
        }
      }
      return content;    
  }

  async createNodeOptions (file, actions) {
    const relPath = path.relative(this.context, file)
    const origin = path.join(this.context, file)
    const content = await fs.readFile(origin, 'utf8').then((val) => {return this.macroSubstituion(val);})

    const { dir, name, ext = '' } = path.parse(file)
    const mimeType = mime.lookup(file) || `application/x-${ext.replace('.', '')}`
    return {
      id: this.createUid(relPath),
      path: this.createPath({ dir, name }, actions),
      fileInfo: {
        extension: ext,
        directory: dir,
        path: file,
        name
      },
      internal: {
        mimeType,
        content,
        origin
      }
    }
  }

  addRefNode (typeName, fieldName, value, actions) {
    const getCollection = actions.getCollection || actions.getContentType
    const cacheKey = `${typeName}-${fieldName}-${value}`

    if (!this.refsCache[cacheKey] && value) {
      this.refsCache[cacheKey] = true

      getCollection(typeName).addNode({ id: value, title: value })
    }
  }

  createPath ({ dir, name }, actions) {
    const { permalinks = {}} = this.api.config
    const pathPrefix = trim(this.options.pathPrefix, '/')
    const pathSuffix = permalinks.trailingSlash ? '/' : ''

    const segments = slash(dir).split('/').map(segment => {
      return actions.slugify(segment)
    })

    if (!this.options.index.includes(name)) {
      segments.push(actions.slugify(name))
    }

    if (pathPrefix) {
      segments.unshift(pathPrefix)
    }

    const res = trimEnd('/' + segments.filter(Boolean).join('/'), '/')

    return (res + pathSuffix) || '/'
  }

  normalizeRefs (refs) {
    return mapValues(refs, (ref) => {
      if (typeof ref === 'string') {
        ref = { typeName: ref, create: false }
      }

      if (!ref.typeName) {
        ref.typeName = this.options.typeName
      }

      if (ref.create) {
        ref.create = true
      } else {
        ref.create = false
      }

      return ref
    })
  }

  createUid (orgId) {
    return crypto.createHash('md5').update(orgId).digest('hex')
  }
}

module.exports = FilesystemSource

