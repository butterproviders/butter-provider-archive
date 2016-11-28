'use strict';
var Q = require('q');
var Generic = require('butter-provider');
var moment = require('moment');
var deferRequest = require('defer-request');
var inherits = require('util').inherits;
var _ = require('lodash');

function Archive(args) {
    if (!(this instanceof Archive)) {
        return new Archive(args);
    }

    Generic.call(this, args);
    this.baseUrl = this.args.baseUrl || 'https://archive.org/';
}
inherits(Archive, Generic);

Archive.prototype.config = {
    name: 'archive',
    uniqueId: 'imdb_id',
    tabName: 'Archive.org',
    type: Generic.TabType.MOVIE,
    args: {
        baseUrl: Generic.ArgType.STRING
    },
    /* should be removed */
    //subtitle: 'ysubs',
    metadata: 'trakttv:movie-metadata'
};

function exctractYear(movie) {
    var metadata = movie.metadata;
    if (metadata.hasOwnProperty('year')) {
        return metadata.year[0];
    } else if (metadata.hasOwnProperty('date')) {
        return metadata.date[0];
    } else if (metadata.hasOwnProperty('addeddate')) {
        return metadata.addeddate[0];
    }

    return 'UNKNOWN';
}

function extractRating(movie) {
    if (movie.hasOwnProperty('reviews')) {
        return movie.reviews.info.avg_rating;
    }

    return 0;
}

function formatOMDbforButter(movie) {
    var id = movie.imdbID;
    var runtime = movie.Runtime;
    var year = movie.Year;
    var rating = movie.imdbRating;

    movie.Quality = '480p'; // XXX

    return {
        type: 'movie',
        aid: movie.archive.identifier,
        imdb: id,
        imdb_id: id,
        title: movie.Title,
        genre: [movie.Genre],
        year: year,
        rating: rating == 'N/A' ? undefined : rating,
        runtime: runtime,
        image: undefined,
        cover: undefined,
        images: {
            poster: undefined
        },
        synopsis: movie.Plot,
        subtitle: {} // TODO
    };
}

function formatDetails(movie, old) {
    var id = movie.metadata.identifier[0];
    /* HACK (xaiki): archive.org, get your data straight !#$!
     *
     * We need all this because data doesn't come reliably tagged =/
     */
    var mp4s = _.filter(movie.files, function (file, k) {
        return k.endsWith('.mp4');
    });

    var url = 'http://' + movie.server + movie.dir;
    var turl = '/' + id + '_archive.torrent';
    var torrentInfo = movie.files[turl];

    // Calc torrent health
    var seeds = 0; //XXX movie.TorrentSeeds;
    var peers = 0; //XXX movie.TorrentPeers;
    movie.Quality = '480p'; // XXX

    var torrents = {};
    torrents[movie.Quality] = {
        url: url + turl,
        size: torrentInfo.size,
        seed: seeds,
        peer: peers
    };

    old.torrents = torrents;
    old.health = false;

    return old;
}

function formatArchiveForButter(movie) {
    var id = movie.metadata.identifier[0];
    var metadata = movie.metadata;

    /* HACK (xaiki): archive.org, get your data straight !#$!
     *
     * We need all this because data doesn't come reliably tagged =/
     */
    var mp4s = _.filter(movie.files, function (file, k) {
        return k.endsWith('.mp4');
    });
    var runtime = Math.floor(
        moment.duration(Number(mp4s[0].length) * 1000).asMinutes()
    );

    console.error('formatArchiveForButter', runtime, movie);
    var year = exctractYear(movie);
    var rating = extractRating(movie);

    return formatDetails(movie, {
        type: 'movie',
        imdb: id,
        title: metadata.title[0],
        year: year,
        rating: rating,
        runtime: runtime,
        image: movie.misc.image,
        cover: movie.misc.image,
        images: {
            poster: movie.misc.image
        },
        synopsis: metadata.description,
        subtitle: {}
    });
}

var queryTorrents = function (baseurl, filters) {
    var query = 'collection:moviesandfilms'; // OR mediatype:movies)';
    query += ' AND NOT collection:movie_trailers';
    query += ' AND -mediatype:collection';
    query += ' AND format:"Archive BitTorrent"';
    query += ' AND year'; // this is actually: has year
    //        query += ' AND avg_rating';

    var URL = baseurl + 'advancedsearch.php';
    var sort = 'downloads';
    //var sort = 'avg_rating';

    var params = {
        output: 'json',
        rows: '50',
        q: query
    };

    if (filters.keywords) {
        params.keywords = filters.keywords.replace(/\s/g, '% ');
    }

    if (filters.genre) {
        params.genre = filters.genre;
    }

    var order = 'desc';
    if (filters.order) {
        if (filters.order === 1) {
            order = 'asc';
        }
    }

    if (filters.sorter && filters.sorter !== 'popularity') {
        sort = filters.sorter;
    }

    sort += '+' + order;

    if (filters.page) {
        params.page = filters.page;
    }

    return deferRequest(URL + '?sort[]=' + sort, params, true)
        .then(function (data) {
            return data.response.docs;
        })
        .catch(function (err) {
            console.error('ARCHIVE.org error:', err);
        });
};

var queryDetails = function (id, movie) {
    id = movie.aid || id || movie.imdb;
    var url = 'https://archive.org/' + 'details/' + id + '?output=json';
    console.info('Request to ARCHIVE.org API', url);
    return deferRequest(url).then(function (data) {
        return data;
    })
        .catch(function (err) {
            console.error('Archive.org error', err);
        });
};

var queryOMDb = function (item) {
    if (! item.title || ! item.title.replace)
        return Q(false);

    var params = {
        t: item.title.replace(/\s+\([0-9]+\)/, ''),
        r: 'json',
        tomatoes: true
    };

    var url = 'http://www.omdbapi.com/';
    return deferRequest(url, params).then(function (data) {
        if (data.Error) {
            throw new Error(data.Error);
        }
        data.archive = item;
        return data;
    });
};

var queryOMDbBulk = function (items) {
    console.error('before details', items);
    var deferred = Q.defer();
    var promises = _.map(items, function (item) {
        return queryOMDb(item)
            .then(formatOMDbforButter)
            .catch(function (err) {
                console.warn('no data on OMDB, going back to archive', err, item);
                return queryDetails(item.identifier, item)
                    .then(formatArchiveForButter);
            });
    });

    Q.all(promises).done(function (data) {
        console.error('queryOMDbbulk', data);
        deferred.resolve({
            hasMore: (data.length < 50),
            results: data
        });
    });

    return deferred.promise;
};

Archive.prototype.fetch = function (filters) {
    return queryTorrents(this.baseUrl, filters)
        .then(queryOMDbBulk);
};

Archive.prototype.detail = function (torrent_id, old_data) {
    return queryDetails(torrent_id, old_data)
        .then(function (data) {
            return formatDetails(data, old_data);
        });
};

module.exports = Archive
