/*
Copyright 2016 International Business Machines Corporation ("IBM")

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

 */
var path = require('path');
var express = require('express');   // The ExpressJS framework
var session = require('cookie-session');
var bodyParser = require('body-parser');
var validator = require('validator');
var watsonTranslate = require('watson-developer-cloud/language-translator/v2');
var port = process.env.PORT || 3000;
/**
 * Setup the Express engine
**/
var app = express();
app.set('port', port);
app.set('view engine', 'ejs');
app.use(session({
	  name: 'cookiesession',
	  secret: 'ssshhhhh'
	}))
app.use( bodyParser.json() );       // to support JSON-encoded bodies
app.use(bodyParser.urlencoded({     // to support URL-encoded bodies
  extended: true
})); 

app.use(express.static(path.join(__dirname, '/public')));

/**
 * Connect to the Watson language translation service
 */
var watsonUser = null;
var watsonPass = null;
//Check if the VCAP_SERVICES environment variable id defined.
//This means we are running on the Bluemix server
if (process.env.VCAP_SERVICES) {
	var env = JSON.parse(process.env.VCAP_SERVICES);
	if (env.language_translator) {
		watsonUser = env.language_translator[0].credentials.username;
		watsonPass = env.language_translator[0].credentials.password;
	}
}
if (!watsonUser || !watsonPass) { //couldn't get credentials, expect calls to translator to fail
	watsonUser = 'None';
	watsonPass = 'None';
}

var languageTranslator = new watsonTranslate({
	  username: watsonUser,
	  password: watsonPass,
	  url: 'https://gateway.watsonplatform.net/language-translator/api'
	});

/**
 * Get Cloudant database info (i.e. load the credentials)
**/
var cloudant = null;
if (process.env.VCAP_SERVICES) {
  var env = JSON.parse(process.env.VCAP_SERVICES);
  if (env.cloudantNoSQLDB) {
	  cloudant = env.cloudantNoSQLDB[0].credentials;
  }
}
if (!cloudant)  //couldn't get credentials, expect calls to database to fail
	cloudant = "https://bluemix.cloudant.com";
/**
 * Connect to the database creatividb
**/
var nano = require('nano')(cloudant);  //added for db
var client = nano.db.use('creatividb'); //db name

//user session
var sess;

translateText = function(toy, translate_field, total_toys, callback){
	languageTranslator.translate({
		text: toy[translate_field], source : 'en', target: sess.language },
		function (err, doc) {
			if(!err){
				toy[translate_field] = doc.translations[0].translation;
				sess.translate_count += 1;
			} else {
		  		console.log("Error translating: ");
		  		console.log(err);
		  		sess.translate_count = total_toys;
			}
			if (sess.translate_count == total_toys) {
				sess.translate_done = true;
				if (sess.fetch_done)
					callback();
			}
	  	});
}

translateToys = function(toy_list, translate_all, callback){
	sess.translate_done = false;
	if (sess.language && (sess.language != 'en')) {
		sess.translate_count = 0;
		var total_toys = 0;
		if (!translate_all) // for list view, translate each overview
			total_toys = Object.keys(toy_list).length;
		else { 
			// if detail page, translate overview (1) + notes (1) + all actionDesc 
			// + all reactToDesc + all propertyDesc + all specialDesc
			toy_name = Object.keys(toy_list)[0];
			total_toys = 1; // overview
			if (toy_list[toy_name].properties) {total_toys += toy_list[toy_name].properties.length;} 
			if (toy_list[toy_name].whenMessageReceived) {total_toys += toy_list[toy_name].whenMessageReceived.length;} 
			if (toy_list[toy_name].sendMessageWhen) {total_toys += toy_list[toy_name].sendMessageWhen.length;} 
			if (toy_list[toy_name].special) {total_toys += toy_list[toy_name].special.length;} 
			if (toy_list[toy_name].notes) {total_toys += 1;} 
		}
		for(toy in toy_list){
			translateText(toy_list[toy], "overview", total_toys, callback);
			if (translate_all) {
				if (toy_list[toy].properties){
					for(var i = 0; i < toy_list[toy].properties.length; i++) { 
						translateText(toy_list[toy].properties[i], "propertyDesc", total_toys, callback);
					}
				}
				if (toy_list[toy].whenMessageReceived){
					for(var i = 0; i < toy_list[toy].whenMessageReceived.length; i++) { 
						translateText(toy_list[toy].whenMessageReceived[i], "actionDesc", total_toys, callback);
					}
				} 
				if (toy_list[toy].sendMessageWhen){
					for(var i = 0; i < toy_list[toy].sendMessageWhen.length; i++) { 
						translateText(toy_list[toy].sendMessageWhen[i], "reactToDesc", total_toys, callback);
					}
				}
				if (toy_list[toy].special){
					for(var i = 0; i < toy_list[toy].special.length; i++) { 
						translateText(toy_list[toy].special[i], "specialDesc", total_toys, callback);
					}
				}
				if (toy_list[toy].notes){
					translateText(toy_list[toy], "notes", total_toys, callback);
				}
			}
		}
	} else {
		sess.translate_done = true;
		if (sess.fetch_done)
			callback();
	}
}

fetchPicture = function(toy_list, callback){
	sess.fetch_done = false;
	var num_toys = 0;
	var total_toys = Object.keys(toy_list).length;
	for(toy in toy_list){
		client.attachment.get(toy_list[toy]._id, Object.keys(toy_list[toy]._attachments)[0], function(err, body, header) {
			if (!err) {
				toy_name = decodeURIComponent(header.uri.split("/creatividb/")[1].split("/")[0]);	// better way?
				toy_list[toy_name].picture = new Buffer(body).toString('base64');
				num_toys += 1;
			} else {
				console.log("Error getting attachment from database: ");
		  		console.log(err);
		  		num_toys = total_toys;
			}
			if (num_toys == total_toys) {
				sess.fetch_done = true;
				if (sess.translate_done)
					callback();
			}
		});
	}
}

app.get('/', function(req, res){
	  sess = req.session;
	  var dbCount = 0;
	  var toy_list = [];
	  var dbCountFun = function(callback_main) {
		  client.fetch({}, function(err_db, docs){
			  if (!err_db) {
				  docs.rows.forEach(function(docname) {
					  if (docname.doc.overview) { // if entry is a toy
						  toy_list[docname.doc._id] = docname.doc;
					  }
				  });
				  translateToys(toy_list, false, callback_main);
				  fetchPicture(toy_list, callback_main);
			  } else {
				  console.log("Error reading from database: ");
				  console.log(err_db)
				  callback_main();
			  }
		  });
	  }
	  
	  displayIndex = ( function () {
		  sess.fetch_done = false;
		  sess.translate_done = false;
		  res.render('index', {toyList: toy_list}); 
	  });
	  
	  dbCountFun(displayIndex);	  
});

app.post('/', function(req, res) {
	sess = req.session;
	var toy_search_results = [];
    var dbSearch = function(callback_main) {
    	//special characters for query are + - & | ! ( ) { } [ ] ^ " ~ * ? : \ /
    	search_string = validator.blacklist(req.body.q, '\\+\\-&\\|!\\(\\)\\{\\}\\[\\]\\^\\"~\\*\\?:\\\\\/')
    	search_string = validator.trim(search_string);
    	// Does not handle spaces in words
        client.search('toyList', 'toySearch',  
        		{q:'name:'+search_string+'* OR overview:'+search_string+'*', include_docs:true, sort:"_id<string>"}, function(er, result){
			if (!er) {
				result.rows.forEach(function(docname) {
					if (docname.doc.overview) {	// if entry is a toy
						toy_search_results[docname.doc._id] = docname.doc;
					}
				});
				if (Object.keys(toy_search_results).length == 0) // no results
					callback_main();
				else {
					translateToys(toy_search_results, false, callback_main);
					fetchPicture(toy_search_results, callback_main)	
				}
			} else {
				console.log("Error searching database: ");
				console.log(er)
				callback_main();
			}
		});
    }
    displaySearch = ( function (  ) {
    	sess.fetch_done = false;
    	sess.translate_done = false;
    	res.render('index', {toyList: toy_search_results}); 
    });
    if (req.body.q) {
    	dbSearch(displaySearch);	
    } else if (req.body.language) {
    	sess.language = req.body.language;
    	res.redirect('/');
    } else {
    	res.redirect('/');
    }
});

app.get('/toy/:name', function(req, res){
	sess = req.session;
	var return_toy = [];
	var getToy = function(callback_main) {
		client.get(req.params.name, function(err, doc, headers) {
			if (!err) {
				return_toy[doc._id] = doc;
				translateToys(return_toy, true, callback_main);
				fetchPicture(return_toy, callback_main)
			} else {
				console.log("Error getting toy from database: ");
				console.log(err)
				callback_main();
			}
		});
	}
	var displayToyInfo = ( function ( ) {
		sess.fetch_done = false;
		sess.translate_done = false;
		if (Object.keys(return_toy).length == 0) // bad toy name
			return_toy[req.params.name] = {_id:"Not Found", overview:"The specified toy could not be found."};
		res.render('toy', {toyDetails: return_toy[req.params.name]}); 
	});
	getToy(displayToyInfo);	  
});

app.post('/toy/:name', function(req, res){
	sess = req.session;
	sess.language = req.body.language;
	res.redirect('/toy/'+req.params.name);
});


app.get('/overview', function(req, res){
	res.render('overview');
});

app.post('/overview', function(req, res){
	sess = req.session;
	sess.language = req.body.language;
	res.redirect('/overview');
});

/* When the user clicks on the button, 
toggle between hiding and showing the dropdown content */
function translate() {
    document.getElementById("myDropdown").classList.toggle("show");
}
/**
 * This is where the server starts to listen on the defined port.
 * Everything previous to this was configuration for this server.
**/
app.listen(app.get('port'), function() {
	console.log('Express server listening on port ' + app.get('port'));
});

console.log('Server running at http://127.0.0.1:'+ port);
