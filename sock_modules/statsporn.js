'use strict';
var fs = require('fs'),
    async = require('async'),
    yml = require('js-yaml'),
    pg = require('pg'),
    plotly = require('plotly'),
    XRegExp = require('xregexp').XRegExp;
var discourse,
    config,
    queries,
    cmdMatcher,
    helpMatcher;
exports.name = 'StatsPorn';
exports.version = '0.5.0';
exports.description = 'Provide stats about TDWTF and it\'s users';
exports.configuration = {
    enabled: false,
    plotlyuser: 'PlotlyUsername',
    plotlypass: 'PlotlyAPIKey',
    connection: 'postgres://discourse:discourse@localhost/discourse'
};

exports.begin = function begin(browser, c) {
    config = c.modules[exports.name];
    discourse = browser;
    plotly = plotly(config.plotlyuser, config.plotlypass);
    cmdMatcher = new XRegExp('@' + c.username +
        '(?<type> (graph|table))? (?<stats>\\w+)(?<args>( (\\S+))*)', 'ig');
    helpMatcher = new XRegExp('@' + c.username + ' (list|list queries)', 'ig');
    async.forever(function (nextTick) {
        loadConfig(function () {
            setTimeout(nextTick, 10 * 60 * 1000);
        });
    });
};

function parseArgs(parts, query, post) {
    var defaults = [],
        trust = post.trust_level,
        i;
    if (parts.args) {
        parts.args = parts.args.trim().split(' ');
    }
    for (; trust >= 0; trust -= 1) {
        if (query.config.defaults[trust]) {
            defaults = query.config.defaults[trust].slice();
            break;
        }
    }
    if (post.trust_level >= 4 && parts.args) {
        for (i = 0; i < parts.args.length && i < defaults.length; i += 1) {
            defaults[i] = parts.args[i];
        }
    } else {
        for (i = 0; i < defaults.length; i += 1) {
            var p = /^%(.+)%$/.exec(defaults[i]);
            if (p) {
                defaults[i] = post[p[1]];
            }
        }
    }
    return defaults;
}

function formatFilename(config, args, post, date) {
    var name = config.chart.filename;
    name = name.replace(/%date%/g, date.toISOString().substring(0, 10));
    name = name.replace(/%username%/g, post.username);
    var word = new XRegExp('%(\\w+)%');
    var pos = 0;
    var match = word.xexec(name, 0);
    while (match) {
        if (/^[1-9]\d*$/.test(match[1])) {
            var i = parseInt(match[1], 10);
            name = name.replace(match[0], args[i - 1]);
        }
        pos = match.index + match[0].length - 1;
        match = word.xexec(name, pos);
    }
    return name;
}

function parseCmd(post) {
    var parts = cmdMatcher.xexec(post.cleaned);
    if (!parts) {
        return null;
    }
    var res = {
        'type': (parts.type || 'graph').trim().toLowerCase(),
        'name': parts.stats.toLowerCase(),
        'args': null,
        'query': null,
        'str': null
    };
    var q = queries.filter(function (q) {
        return q.name.toLowerCase() === res.name;
    })[0];
    if (!q) {
        return null;
    }
    if (post.trust_level < q.config.trust_level) {
        return null;
    }
    res.args = parseArgs(parts, q, post);
    res.query = q;
    res.str = q.name + ' ' + res.args.join(' ');
    return res;
}

function queryToTable(cmd, query, date, rows, callback) {
    function tostring(o) {
        if (typeof o.toUTCString === 'function') {
            var data = o.toISOString().replace(/\..+$/, '');
            if (o.getHours() !== 0 || o.getMinutes() !== 0) {
                return data.replace('T', ' ');
            } else {
                return data.replace(/T.+$/, '');
            }
        }
        return '' + o;
    }
    var res = [];
    res.push(cmd.str);
    res.push('');
    res.push(query.query.replace(/c09fa970-5a9a-11e4-8ed6-0800200c9a66/g,
        '[Magic Exclusion UUID]'));
    res.push('');
    if (rows && rows[0]) {
        res.push(Object.keys(rows[0]).join('\t| '));
        res = res.concat(rows.map(function (r) {
            return Object.keys(r).map(function (k) {
                return tostring(r[k]);
            }).join('\t| ');
        }));
    } else {
        res.push('No Results Found');
    }
    callback(null, '\n```\n' + res.join('\n') + '\n\nBackup Date: ' +
        date.toUTCString() + '\n```\n');
}

function queryToChart(cmd, query, date, filename, rows, callback) {
    var data = query.chart.data,
        layout = query.chart.layout;
    data = JSON.parse(JSON.stringify(data));
    data.map(function (d) {
        for (var series in d) {
            if (series.length === 1) {
                d[series] = rows.map(function (m) {
                    return m[d[series]];
                });
            }
        }
        if (d.text) {
            d.text = rows.map(function (m) {
                var res = d.text;
                for (var name in m) {
                    res = res.replace('%' + name + '%', m[name]);
                }
                return res;
            });
        }
    });
    var layout2 = {
        fileopt: 'overwrite',
        filename: filename,
        layout: layout
    };
    plotly.plot(data, layout2, function (err, msg) {
        if (err) {
            return callback(err);
        }
        var res = [];
        res.push(cmd.str);
        res.push('');
        res.push(query.query.replace(/c09fa970-5a9a-11e4-8ed6-0800200c9a66/g,
            '[Magic Exclusion UUID]'));
        res.push('');
        res.push('Backup Date: ' + date.toUTCString());
        res = '\n```\n' + res.join('\n') + '\n```\n';
        var txt = '[<img src="%%.svg" height="500" width="700" /><br/>Click for interactive graph.](%%)';
        callback(null, res + txt.replace(/%%/g, msg.url));
    });
}

exports.onNotify = function (type, notification, topic, post, callback) {
    if (['private_message', 'mentioned', 'replied'].indexOf(type) < 0) {
        return callback();
    }
    var cmd = parseCmd(post);
    if (!cmd || !cmd.query) {
        if (helpMatcher.test(post.cleaned)) {
            return listQueries(notification, callback);
        }
        return callback();
    }
    callback(true);
    doQuery(cmd, notification, post, function () {});
};

function listQueries(notification, callback) {
    var res = queries.map(function (q) {
        var args;
        for (var i = 0; i <= 10; i += 1) {
            if (q.config.defaults[i]) {
                args = '\'' + q.config.defaults[i].join('\' \'') + '\'';
                break;
            }
        }
        return q.name + ' ' + args + ':\tAvaliable to trust level ' +
            q.config.trust_level + '+';
    });
    res.unshift('Available queries:');
    res.unshift('');
    res.unshift('```text');
    res.push('```');
    return discourse.createPost(notification.topic_id,
        notification.post_number, res.join('\n'),
        function () {
            callback(true);
        });
}

function doQuery(cmd, notification, post, callback) {
    var date;
    var query = cmd.query;
    var client = new pg.Client(config.connection);
    async.waterfall([
            function (next) {
                client.connect(next);
            },
            function (c, next) {
                var latest = 'SELECT created_at FROM post_actions' +
                    ' ORDER BY created_at DESC LIMIT 1';
                client.query(latest, [], function (err, result) {
                    if (!err) {
                        date = result.rows[0].created_at;
                    }
                    next(err, result);
                });
            },
            function (c, next) {
                client.query(query.query, cmd.args, next);
            },
            function (result, next) {
                if (!query.chart || !result.rows || result.rows.length < 2 ||
                    cmd.type === 'table') {
                    return queryToTable(cmd, query, date, result.rows, next);
                }
                var filename = formatFilename(query, cmd.args, post, date);
                queryToChart(cmd, query, date, filename, result.rows, next);
            },
            function (post, next) {
                return discourse.createPost(notification.topic_id,
                    notification.post_number, post, next);
            }
        ],
        function (err) {
            if (err) {
                discourse.error('Error creating statsporn: ' + err);
                return discourse.createPost(notification.topic_id,
                    notification.post_number, 'An error occured making stats',
                    function () {
                        callback(true);
                    });
            }
            callback(true);
        });
}

function loadConfig(callback) {
    async.waterfall([
        function (next) {
            fs.readFile('./sock_modules/stats.yml', next);
        },
        function (file, next) {
            try {
                var doc = yml.safeLoad(file);
                queries = doc;
            } catch (e) {
                discourse.warn('Error loading query yaml: ' + e);
            }
            next();
        }
    ], function (error) {
        if (error) {
            discourse.error(error);
        }
        callback();
    });
}