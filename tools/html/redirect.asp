<%@ language="javascript"%>

<%
  var s = String(Request.ServerVariables("HTTP_ACCEPT"));
  var filename = "<%filename%>";
  var htmlFilename = filename;
  if (htmlFilename.indexOf("operation-") == 0) {
    var operation = htmlFilename.substring(10);
    var dash = operation.indexOf("-");
    if (dash > -1) {
      htmlFilename = operation.substring(0, dash) + "-operation-" + operation.substring(dash + 1);
    }
  }

  if (s.indexOf("json") > -1) 
    Response.Redirect("http://hl7.org/fhir/" + filename + ".json");
  else if (s.indexOf("html") > -1) 
    Response.Redirect("http://hl7.org/fhir/" + htmlFilename + ".html");
  else
    Response.Redirect("http://hl7.org/fhir/" + filename + ".xml");

%>

<!DOCTYPE html>
<html>
<body>
You should not be seeing this page. If you do, ASP has failed badly.
</body>
</html>