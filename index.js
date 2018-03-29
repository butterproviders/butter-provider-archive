'use strict';

var Provider = require('butter-provider');
var moment = require('moment');
var axios = require('axios');
var debug = require('debug')('butter-provider-archive');

const defaultConfig = {
    name: 'archive',
    uniqueId: 'imdb_id',
    tabName: 'Archive.org',
    argTypes: {
        baseUrl: Provider.ArgType.STRING,
        timeout: Provider.ArgType.NUMBER
    },
    defaults: {
        baseUrl: 'https://archive.org',
        timeout: 10000
    },
    /* should be removed */
    //subtitle: 'ysubs',
    metadata: 'trakttv:movie-metadata'
};

function exctractYear(movie) {
    var metadata = movie.metadata;

    if (metadata.year) {
        return metadata.year[0];
    }

    if (metadata.date) {
        return metadata.date[0];
    }

    if (metadata.addeddate) {
        return metadata.addeddate[0];
    }

    return 'UNKNOWN';
}

function extractRating(movie) {
    if (movie.reviews) {
        return movie.reviews.info.avg_rating;
    }

    return 0
}

function formatOMDbforButter(movie) {
    var id = movie.imdbID;
    var runtime = movie.Runtime;
    var year = movie.Year;
    var rating = movie.imdbRating;

    movie.Quality = '480p'; // XXX

    return {
        type: Provider.ItemType.MOVIE,
        aid: movie.archive.identifier,
        imdb: id,
        imdb_id: id,
        title: movie.Title,
        genre: [movie.Genre],
        year: year,
        rating: rating === 'N/A' ? null : rating,
        runtime: runtime,
        backdrop: null,
        poster: null,
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
    var url = `http://${movie.server}${movie.dir}`;
    var turl = `/${id}_archive.torrent`;
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
    var mp4s = Object.keys(movie.files)
                     .filter((k) => (k.endsWith('.mp4')))
                     .map((k) => (movie.files[k]))

    if (!mp4s.length) {
        debug('couldnt find any valid file in this...', movie);

        return null;
    }

    var runtime =
        Math.floor(moment.duration(Number(mp4s[0].length) * 1000).asMinutes());

    var year = exctractYear(movie);
    var rating = extractRating(movie);

    return formatDetails(movie, {
        type: 'movie',
        imdb: id,
        title: metadata.title[0],
        year: year,
        rating: rating,
        runtime: runtime,
        backdrop: movie.misc.image,
        poster: movie.misc.image,
        synopsis: metadata.description,
        subtitle: {}
    });
}

function queryOMDb (item, axiosOptions) {
    if (!item.title || !item.title.replace) {
        return Promise.reject(new Error('Not Found'));
    }

    var params = {
        t: item.title.replace(/\s+\([0-9]+\)/, ''),
        r: 'json',
        tomatoes: true
    };

    var url = 'http://www.omdbapi.com/';

    return axios(url, Object.assign({}, axiosOptions, {params: params}))
        .then((res) => {
            if (res.data.Error) {
                throw new Error(res.data.Error);
            }

            res.data.archive = item;

            return res.data;
        });
}

module.exports = class Archive extends Provider {
    constructor (args, config = defaultConfig) {
        super(args, config)

        this.baseUrl = this.args.baseUrl;
        this.axiosOptions = {
            strictSSL: false,
            json: true,
            timeout: this.args.timeout
        }
    }

    queryTorrents (filters = {}) {
        var query = 'collection:moviesandfilms'; // OR mediatype:movies)';
        query += ' AND NOT collection:movie_trailers';
        query += ' AND -mediatype:collection';
        query += ' AND format:"Archive BitTorrent"';
        query += ' AND year'; // this is actually: has year
        //        query += ' AND avg_rating';

        var URL = `${this.baseUrl}/advancedsearch.php`;
        var sort = 'downloads';
        //var sort = 'avg_rating';

        var params = {
            output: 'json',
            rows: '50',
            q: query
        };

        if (filters.keywords) {
            query += ` AND title:"${filters.keywords}"`;
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

        sort += `+${order}`;

        if (filters.page) {
            params.page = filters.page;
        }

        return axios(
            `${URL}?sort[]=${sort}`,
            Object.assign({}, this.axiosOptions, {params: params})
        ).then((res) => (res.data.response.docs))
         .catch((err) => (debug('ARCHIVE.org error:', err)));
    }

    queryDetails (aid, movie) {
        let id = movie.aid || aid || movie.imdb;
        var url = `${this.baseUrl}/details/${id}?output=json`;

        return axios(url, this.axiosOptions)
            .then((res) => (res.data));
    }

    queryOMDbBulk (items) {
        let promises =
            items.map((item) => (queryOMDb(item, this.axiosOptions)
                                     .then(formatOMDbforButter)
                                     .catch((err) => {
                                         debug('WARN: no data on OMDB, going back to archive', err, item);

                                         return this.queryDetails(item.identifier, item)
                                                    .then(formatArchiveForButter)
                                                    .catch((err) => (null))
                                     })));

        return new Promise((resolve) => {
            Promise.all(promises).then((data) => {
                let filtredData = data.filter((m) => (m))
                resolve({
                    hasMore: (filtredData.length < 50),
                    results: filtredData
                });
            })
        });
    }

    fetch (filters = {}) {
        return this.queryTorrents(filters)
                   .then(this.queryOMDbBulk.bind(this));
    }

    detail (torrent_id, old_data) {
        return this.queryDetails(torrent_id, old_data)
            .then((data) => (formatDetails(data, old_data)));
    }
}
