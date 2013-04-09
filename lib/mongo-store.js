/* Copyright (c) 2010-2013 Richard Rodger, MIT License */
"use strict";


var _     = require('underscore')
var mongo = require('mongodb')


var name = "mongo-store"


var MIN_WAIT = 16
var MAX_WAIT = 65336


/*
native$ = object => use object as query, no meta settings
native$ = array => use first elem as query, second elem as meta settings
*/


function makeid(hexstr) {
  if( mongo.BSONNative ) {
    return new mongo.BSONNative.ObjectID(hexstr)
  }
  else {
    return new mongo.BSONPure.ObjectID(hexstr)
  }
}


function fixquery(qent,q) {
  var qq = {};

  if( !q.native$ ) {
    for( var qp in q ) {
      if( !qp.match(/\$$/) ) {
        qq[qp] = q[qp]
      }
    }
    if( qq.id ) {
      qq._id = makeid(qq.id)
      delete qq.id
    }
  }
  else {
    qq = _.isArray(q.native$) ? q.native$[0] : q.native$
  }

  return qq
}


function metaquery(qent,q) {
  var mq = {}

  if( !q.native$ ) {

    if( q.sort$ ) {
      for( var sf in q.sort$ ) break;
      var sd = q.sort$[sf] < 0 ? 'descending' : 'ascending'
      mq.sort = [[sf,sd]]
    }

    if( q.limit$ ) {
      mq.limit = q.limit$
    }

    if( q.skip$ ) {
      mq.skip = q.skip$
    }

    if( q.fields$ ) {
      mq.fields = q.fields$
    }
  }
  else {
    mq = _.isArray(q.native$) ? q.native$[1] : mq
  }

  return mq
}




module.exports = function(seneca,opts,cb) {
  var desc


  opts.minwait = opts.minwait || MIN_WAIT
  opts.maxwait = opts.maxwait || MAX_WAIT

  var minwait
  var dbinst  = null
  var collmap = {}
  var specifications = null



  function error(args,err,cb) {
    if( err ) {
      seneca.log.debug(args.actid$,'error: '+err)
      seneca.fail({code:'entity/error',store:name},cb)

      if( 'ECONNREFUSED'==err.code || 'notConnected'==err.message || 'Error: no open connections' == err ) {
        if( minwait = opts.minwait ) {
          collmap = {}
          reconnect(args)
        }
      }

      return true
    }

    return false
  }


  function reconnect(args) {
    seneca.log.debug(args.actid$,'attempting db reconnect')

    configure(specifications, function(err){
      if( err ) {
        seneca.log.debug(args.actid$,'db reconnect (wait '+opts.minwait+'ms) failed: '+err)
        minwait = Math.min(2*minwait,opts.maxwait)
        setTimeout( function(){reconnect(args)}, minwait )
      }
      else {
        minwait = opts.minwait
        seneca.log.debug(args.actid$,'reconnect ok')
      }
    })
  }


  function configure(spec,cb) {
    specifications = spec

    // defer connection
    // TODO: expose connection action
    if( !_.isUndefined(spec.connect) && !spec.connect ) {
      return cb()
    }


    var conf = 'string' == typeof(spec) ? null : spec

    if( !conf ) {
      conf = {}
      var urlM = /^mongo:\/\/((.*?):(.*?)@)?(.*?)(:?(\d+))?\/(.*?)$/.exec(spec);
      conf.name   = urlM[7]
      conf.port   = urlM[6]
      conf.server = urlM[4]
      conf.username = urlM[2]
      conf.password = urlM[3]

      conf.port = conf.port ? parseInt(conf.port,10) : null
    }


    conf.host = conf.host || conf.server
    conf.username = conf.username || conf.user
    conf.password = conf.password || conf.pass

    
    var dbopts = seneca.util.deepextend({
      native_parser:false,
      auto_reconnect:true,
      w:1
    },conf.options)
    

    if( conf.replicaset ) {
      var rservs = []
      for( var i = 0; i < conf.replicaset.servers.length; i++ ) {
	var servconf = conf.replicaset.servers[i]
	rservs.push(new mongo.Server(servconf.host,servconf.port,dbopts))
      }
      var rset = new mongo.ReplSetServers(rservs)
      dbinst = new mongo.Db(
	conf.name, rset
      )
    }
    else {
      dbinst = new mongo.Db(
        conf.name,
        new mongo.Server(
          conf.host || conf.server, 
          conf.port || mongo.Connection.DEFAULT_PORT, 
          {}
        ), 
        dbopts
      )
    }


    // FIX: error reporting sucks on login fail
    dbinst.open(function(err){
      if( !error({actid$:'init'},err,cb) ) {
        minwait = MIN_WAIT

        if( conf.username ) {

          dbinst.authenticate(conf.username,conf.password,function(err){
            // do not attempt reconnect on auth error
            if( err) {
              cb(err)
            }
            else {
              seneca.log.debug('init','db open and authed for '+conf.username,dbopts)
              cb(null)
            }
          })
        }
        else {
          seneca.log.debug('init','db open',dbopts)
          cb(null)
        }
      }
    });
  }


  function getcoll(args,ent,cb) {
    var canon = ent.canon$({object:true})

    var collname = (canon.base?canon.base+'_':'')+canon.name

    if( !collmap[collname] ) {
      dbinst.collection(collname, function(err,coll){
        if( !error(args,err,cb) ) {
          collmap[collname] = coll
          cb(null,coll);
        }
      })
    }
    else {
      cb(null,collmap[collname])
    }
  }





  var store = {
    name:name,

    close: function(cb) {
      if(dbinst) {
        dbinst.close(cb)
      }
    },

    
    save: function(args,cb) {
      var ent = args.ent    

      var update = !!ent.id;

      getcoll(args,ent,function(err,coll){
        if( !error(args,err,cb) ) {
          var entp = {};

          var fields = ent.fields$()
          fields.forEach( function(field) {
            entp[field] = ent[field]
          })

          if( update ) {
            var q = {_id:makeid(ent.id)}
            delete entp.id

            coll.update(q,entp,{upsert:true},function(err,update){
              if( !error(args,err,cb) ) {
                seneca.log.debug(args.actid$,'save/update',ent,desc)
                cb(null,ent)
              }
            })
          }
          else {
            coll.insert(entp,function(err,inserts){
              if( !error(args,err,cb) ) {
                ent.id = inserts[0]._id.toHexString()

                seneca.log.debug(args.actid$,'save/insert',ent,desc)
                cb(null,ent)
              }
            })
          }
        }
      })
    },


    load: function(args,cb) {
      var qent = args.qent
      var q    = args.q

      getcoll(args,qent,function(err,coll){
        if( !error(args,err,cb) ) {
          var mq = metaquery(qent,q)
          var qq = fixquery(qent,q)

          coll.findOne(qq,mq,function(err,entp){
            if( !error(args,err,cb) ) {
              var fent = null;
              if( entp ) {
                entp.id = entp._id.toHexString();
                delete entp._id;

                fent = qent.make$(entp);
              }

              seneca.log.debug(args.actid$,'load',q,fent,desc)
              cb(null,fent);
            }
          });
        }
      })
    },


    list: function(args,cb) {
      var qent = args.qent
      var q    = args.q

      getcoll(args,qent,function(err,coll){
        if( !error(args,err,cb) ) {
          var mq = metaquery(qent,q)
          var qq = fixquery(qent,q)

          coll.find(qq,mq,function(err,cur){
            if( !error(args,err,cb) ) {
              var list = []

              cur.each(function(err,entp){
                if( !error(args,err,cb) ) {
                  if( entp ) {
                    var fent = null;
                    if( entp ) {
                      entp.id = entp._id.toHexString();
                      delete entp._id;

                      fent = qent.make$(entp);
                    }
                    list.push(fent)
                  }
                  else {
                    seneca.log.debug(args.actid$,'list',q,list.length,list[0],desc)
                    cb(null,list)
                  }
                }
              })
            }
          })
        }
      })
    },


    remove: function(args,cb) {
      var qent = args.qent
      var q    = args.q

      var all  = q.all$ // default false
      var load  = _.isUndefined(q.load$) ? true : q.load$ // default true 

      getcoll(args,qent,function(err,coll){
        if( !error(args,err,cb) ) {
          var qq = fixquery(qent,q)        

          if( all ) {
            coll.remove(qq,function(err){
              seneca.log.debug(args.actid$,'remove/all',q,desc)
              cb(err)
            })
          }
          else {
            var mq = metaquery(qent,q)
            coll.findOne(qq,mq,function(err,entp){
              if( !error(args,err,cb) ) {
                if( entp ) {
                  coll.remove({_id:entp._id},function(err){
                    seneca.log.debug(args.actid$,'remove/one',q,entp,desc)

                    var ent = load ? entp : null
                    cb(err,ent)
                  })
                }
                else cb(null)
              }
            })
          }
        }
      })
    },

    native: function(args,done) {
      dbinst.collection('seneca', function(err,coll){
        if( !error(args,err,cb) ) {
          coll.findOne({},{},function(err,entp){
            if( !error(args,err,cb) ) {
              done(null,dbinst)
            }else{
              done(err)
            }
          })
        }else{
          done(err)
        }
      })
    }
  }



  seneca.store.init(seneca,opts,store,function(err,tag,description){
    if( err ) return cb(err);

    desc = description

    configure(opts,function(err){
      if( err ) {
        return seneca.fail({code:'entity/configure',store:store.name,error:err},cb)
      } 
      else cb(null,{name:store.name,tag:tag});
    })
  })
}












