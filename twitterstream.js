// Description:
//  Subscribe to tweets matching keywords
//
// Commands:
//   hubot twitterstream track <keyword>   - Start watching a keyword
//   hubot twitterstream untrack <keyword> - Stop  watching a keyword
//   hubot twitterstream watch <screen_name>   - Start watching tweets from @screen_name
//   hubot twitterstream untrack <screen_name> - Stop watching tweets from @screen_name
//   hubot twitterstream list          - Get the watched keywords list in current room
//   hubot twitterstream clear         - Stop watching all keywords in current room
//
// Configuration:
//
// The following environment variables are required. You will need to create an application at https://dev.twitter.com
//
// HUBOT_TWITTERSTREAM_CONSUMER_KEY
// HUBOT_TWITTERSTREAM_CONSUMER_SECRET
// HUBOT_TWITTERSTREAM_ACCESS_TOKEN_KEY
// HUBOT_TWITTERSTREAM_ACCESS_TOKEN_SECRET
//
// HUBOT_TWITTERSTREAM_CLEAN_SUBSCRIPTIONS: Clear all subscriptions at boot time.
//
// Examples:
//   hubot twitterstream track github
//   hubot twitterstream follow nodejs
//
// Author:
//   Christophe Hamerling

var Twit = require('twit');
var _ = require('lodash');

var BRAIN_TWITTER_STREAMS = 'twitterstreams';
var TYPES = {
  TRACK: 'track',
  FOLLOW: 'follow'
};

var auth = {
  consumer_key: process.env.HUBOT_TWITTERSTREAM_CONSUMER_KEY,
  consumer_secret: process.env.HUBOT_TWITTERSTREAM_CONSUMER_SECRET,
  access_token: process.env.HUBOT_TWITTERSTREAM_ACCESS_TOKEN_KEY,
  access_token_secret: process.env.HUBOT_TWITTERSTREAM_ACCESS_TOKEN_SECRET
}

var loaded = false;
var streams = [];
var twit = new Twit(auth);

module.exports = function(robot) {

  robot.respond(/twitterstream clear/i, _auth.bind(null, clear));
  robot.respond(/twitterstream follow (.*)$/i, _auth.bind(null, follow));
  robot.respond(/twitterstream list/i, _auth.bind(null, list));
  robot.respond(/twitterstream unfollow (.*)$/i, _auth.bind(null, unfollow));
  robot.respond(/twitterstream untrack (.*)$/i, _auth.bind(null, untrack));
  robot.respond(/twitterstream track (.*)$/i, _auth.bind(null, track));

  robot.brain.on('loaded', function(data) {
    if (loaded) {
      // this loaded event is sent on each robot.brain.set, skip it
      return;
    }
    loaded = true;

    if (process.env.HUBOT_TWITTERSTREAM_CLEAN_SUBSCRIPTIONS) {
      robot.brain.data[BRAIN_TWITTER_STREAMS] = [];
      return;
    }

    restoreSubscriptions();
  });


  function _auth(command,msg) {
    var role, user;
    role = 'twitterbot';
    user = robot.brain.userForName(msg.message.user.name);
    if (user == null) {
      return msg.send(name + " does not exist");
    }
    if (!robot.auth.hasRole(user, role)) {
      msg.send("Access Denied. You need role " + role + " to perform this action.");
      return;
    }
     return command(msg)
  }

  function clear(msg) {

    function match(subscription) {
      return subscription.room === msg.message.room;
    }

    var toRemove = _.remove(streams, match);

    if (!toRemove.length) {
      return msg.send('No subscription in this room');
    }

    toRemove.forEach(function(subscription) {
      subscription.stream.stop();
    });

    _.remove(robot.brain.data[BRAIN_TWITTER_STREAMS], match);

    msg.send('Unsubscribed from all');
  }

  function createStream(type, tag, room, screen_name) {
    var filter = {tweet_mode: 'extended'};
    filter[type] = tag;

    var stream = twit.stream('statuses/filter', filter);

    stream.on('tweet', function(tweet) {
      function isReply(_tweet) {
        if (_tweet.in_reply_to_status_id
          || _tweet.in_reply_to_status_id_str
          || _tweet.in_reply_to_user_id
          || _tweet.in_reply_to_user_id_str
          || _tweet.in_reply_to_screen_name )
          return true
        return false
      }

      function send() {
        if (!screen_name || (tweet.user.screen_name.trim() === screen_name.trim())) {
          var tweet_url = "https://twitter.com/"+tweet.user.screen_name+"/status/"+tweet.id_str
          var message = tweet.extended_tweet ? tweet.extended_tweet.full_text : tweet.text;

          function replaceURL(item){ message = message.replace(item.url, item.expanded_url) }

          // URL Expanding for user trust
          if(tweet.extended_tweet){
            if(tweet.extended_tweet.entities && tweet.extended_tweet.entities.urls){
              tweet.extended_tweet.entities.urls.forEach(replaceURL)
            }
          } else {
            if(tweet.entities && tweet.entities.urls){
              tweet.text = tweet.entities.urls.forEach(replaceURL)
            }
          }
          var roomPromise = robot.adapter.getRoomId(room)

          roomPromise.then(function(roomName){
            sendCustomMessage(robot.adapter, roomName, tweet, message)
          })

          function sendCustomMessage(_adp, _roomname, _tweet, _msg){

            var retweetTemplate = "[:retweet: Retweet!](https://twitter.com/intent/retweet?tweet_id="+_tweet.id_str+")"
            var replyTemplate   = "[:reply_tweet: Reply!](https://twitter.com/intent/tweet?in_reply_to="+_tweet.id_str+")"
            var likeTemplate    = "[:like_tweet: Like!](https://twitter.com/intent/like?tweet_id="+_tweet.id_str+")"

            _adp.customMessage({
              channel: _roomname, //channel: 'sJRNTGfnbGfypbquP', // <-- HARDCODED BEFORE
              msg: '',
              attachments: [
                {
                   title: "@"+_tweet.user.screen_name+":",
                   title_link: _tweet,
                   text: _msg + "\n\n" + retweetTemplate + "    " + replyTemplate + "    " + likeTemplate,
                   author_name: _tweet.user.name,
                   author_link: "http://twitter.com/" + _tweet.user.screen_name,
                   image_url: ''
                }
              ]
            });
          }

        }
      }

      if (type === TYPES.FOLLOW) {
        if (tweet.user.id_str === tag && !isReply(tweet)) send();
      } else {
        if (!isReply(tweet)) send();
      }
    });

    robot.logger.info('Started a new twitter stream', filter);

    saveStream(type, tag, room, stream);
  }

  function follow(msg) {
    getIdFromScreenName(msg.match[1], function(err, id) {
      if (err) {
        return robot.logger.error('Can not get twitter user id from ' + msg.match[1], err);
      }
      createStream(TYPES.FOLLOW, id, msg.message.room, msg.match[1]);
    });
  }

  function getIdFromScreenName(screen_name, callback) {
    twit.get('users/lookup', {screen_name: screen_name}, function(err, response) {
      if (err) {
        return callback(err);
      }

      if (!response || !response.length) {
        return callback(new Error('User not found'));
      }

      callback(null, response[0].id_str);
    });
  }

  function list(msg) {
    msg.send('I am listening to tweets:');

    var currentRoomTags = streams.filter(function(subscription) {
      return subscription.room === msg.message.room;
    }).map(function(subscription) {
      if (subscription.room === msg.message.room) {
        return '- ' + subscription.tag;
      }
    });

    if (currentRoomTags.length) {
      return msg.send(currentRoomTags.join('\n'));
    }

    msg.send('No subscriptions. Hint: Type \'twitterstream track/follow XXX\' to listen to XXX related tweets in current room');
  }

  function restoreSubscriptions() {
    var subscriptions = robot.brain.data[BRAIN_TWITTER_STREAMS];

    if (!subscriptions || !subscriptions.length) {
      return robot.brain.data[BRAIN_TWITTER_STREAMS] = [];
    }

    subscriptions.forEach(restoreSubscription);
  }

  function restoreSubscription(subscription) {
    if (!subscription || !subscription.tag || !subscription.room || !subscription.type) {
      return robot.logger.error('Can not restore follow subscription', subscription);
    }

    createStream(subscription.type, subscription.tag, subscription.room);
  }

  function saveStream(type, tag, room, stream) {
    streams.push({stream: stream, tag: tag, room: room, type: type});
    var found = _.find(robot.brain.data[BRAIN_TWITTER_STREAMS], function(subscription) {
      return subscription.tag === tag && subscription.room === room && subscription.type === type;
    });

    if (!found) {
      if(robot.brain.data[BRAIN_TWITTER_STREAMS])
          robot.brain.data[BRAIN_TWITTER_STREAMS].push({tag: tag, room: room, type: type});
      else{
            robot.brain.data[BRAIN_TWITTER_STREAMS] = []
            robot.brain.data[BRAIN_TWITTER_STREAMS].push({tag: tag, room: room, type: type});
        }
    }
  }

  function unsubscribe(type, tag, room) {
    function match(subscription) {
      return subscription.room === room && subscription.tag === tag && subscription.type === type;
    }

    var toRemove = _.remove(streams, match);
    if (!toRemove.length) {
      // TODO: Warn
      return;
    }

    toRemove.forEach(function(subscription) {
      subscription.stream.stop();
    });

    _.remove(robot.brain.data[BRAIN_TWITTER_STREAMS], match);
  }

  function unfollow(msg) {
    var screen_name = msg.match[1];

    getIdFromScreenName(screen_name, function(err, id) {
      if (err) {
        return robot.logger.error('Can not get twitter user id from ' + screen_name, err);
      }

      unsubscribe(TYPES.FOLLOW, id, msg.message.room);
      msg.send('I stopped to watch tweets from "' + screen_name + '"');
    });
  }

  function untrack(msg) {
    var word = msg.match[1];
    unsubscribe(TYPES.TRACK, word, msg.message.room);
    msg.send('I stopped to watch tweets about "' + word + '"');
  }

  function track(msg) {
    createStream(TYPES.TRACK, msg.match[1], msg.message.room);
  }
};
