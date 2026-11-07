// 모든 화면 공통: 로그인이 풀린 뒤(30일 지나거나 비밀번호가 바뀜) API 가 401 을 주면 로그인 화면으로 보낸다.
(function(){
  var orig = window.fetch;
  var moving = false;
  window.fetch = function(){
    return orig.apply(this, arguments).then(function(res){
      if (res.status === 401 && !moving) {
        res.clone().json().then(function(d){
          if (d && d.login && !moving) {
            moving = true;
            location.href = '/login.html?next=' + encodeURIComponent(location.pathname + location.search + location.hash);
          }
        }).catch(function(){});
      }
      return res;
    });
  };
})();
